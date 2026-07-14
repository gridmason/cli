/**
 * The **SDK inspector** (SPEC §4, FR-6): the author-feedback surface that shows,
 * for one `gridmason dev` mount, **every capability the manifest declared** against
 * **every gated SDK call the widget actually made** — flagging any call whose
 * capability the manifest did *not* declare as a **violation** (the reach a review
 * would reject, surfaced before review), and tagging each call **fixture-hit** vs
 * **default-empty** so the author sees which data paths their fixtures don't cover
 * yet.
 *
 * It is a pure feedback lens: it changes no runtime behavior and originates no
 * data. The classification is not re-derived here — the SDK **fixture
 * implementation** already tags each gated call with its outcome
 * (`@gridmason/sdk/fixture`, cli §4), so the harness reports the fixture's own
 * verdict and this module only *enriches* it with the capability the call required
 * and whether the live manifest declares it (reusing the one capability grammar in
 * `./proxy.ts`, itself derived from `@gridmason/protocol`). Fixture-mount reports
 * arrive over `POST /@dev/inspect`; `--proxy` mounts are recorded server-side from
 * the same enforcement path. Both land in one {@link InspectorLog} the inspector
 * page reads on load and follows live over the shared SSE channel.
 */
import { type Capability, formatCapability } from '@gridmason/protocol';
import type { SdkMethod } from '@gridmason/sdk/noop';
import { ENDPOINTS } from './endpoints.js';
import { grantingCapability, requiredCapability, toCapability } from './proxy.js';

/**
 * How an observed gated call resolved. The first four are the SDK fixture
 * implementation's own outcome tags (`@gridmason/sdk/fixture`); the last two are
 * the `--proxy` equivalents the dev server records when it forwards a call to a
 * real host instead of a fixture.
 */
export type ObservationOutcome =
  /** A fixture matched; the call returned fixture data. */
  | 'fixture-hit'
  /** Allowed, but no fixture matched; the SDK's typed-empty default was returned. */
  | 'default-empty'
  /** A gated `events` call (no fixture concept) that passed its capability check. */
  | 'allowed'
  /** The capability check failed — the manifest did not declare it. */
  | 'denied'
  /** `--proxy` mode: allowed and forwarded to the real host. */
  | 'proxied'
  /** `--proxy` mode: allowed, but the proxy target was unreachable or errored. */
  | 'proxy-error';

/**
 * What a consumer reports about one gated SDK call it saw: the dotted method, how
 * it resolved, and the call's **first argument** (the scope source — a `RecordRef`,
 * a `NetRequest`, a `TopicRef`), from which the required capability is derived
 * exactly as a host would. Only the first argument is needed and carried, so a
 * non-serializable trailing argument (an `events.on` handler) never crosses the wire.
 */
export interface RawObservation {
  /** The dotted SDK method, e.g. `records.read`. */
  readonly method: SdkMethod;
  /** How the call resolved (the fixture SDK's tag, or the proxy equivalent). */
  readonly outcome: ObservationOutcome;
  /** The call's first argument — the capability-scope source. */
  readonly arg: unknown;
}

/** A {@link RawObservation} enriched with the capability it required and whether the manifest declares it. */
export interface SdkObservation {
  /** Arrival ordinal within the current mount session (`0`-based; resets each mount). */
  readonly seq: number;
  /** The dotted SDK method. */
  readonly method: SdkMethod;
  /** The required capability's api, or `null` for an ungated call. */
  readonly api: string | null;
  /** The required capability in `<api>[:<scope>]` form, or `null` for an ungated call. */
  readonly capability: string | null;
  /** How the call resolved. */
  readonly outcome: ObservationOutcome;
  /** Whether the manifest declares a capability that grants this call (always `true` when ungated). */
  readonly declared: boolean;
  /** A gated call whose capability the manifest did **not** declare — the review-flagging reach. */
  readonly violation: boolean;
  /** The declared capability that granted the call, or `null` when ungated or a violation. */
  readonly grantedBy: string | null;
}

/** The current inspector session: the live declared capabilities and the calls observed so far. */
export interface InspectorSession {
  /** Every capability the live manifest declares, in `<api>[:<scope>]` form. */
  readonly declared: readonly string[];
  /** Every gated call observed since the current mount began, in arrival order. */
  readonly calls: readonly SdkObservation[];
}

/**
 * Enrich a reported call with the capability it required and whether `declared`
 * grants it. An **ungated** call (`requiredCapability` → `null`: settings / nav /
 * telemetry) carries no capability and can never be a violation. A **gated** call
 * is a violation exactly when no declared capability grants it — the same
 * `min(user, widget)` containment the fixture SDK and the proxy gate apply, so the
 * inspector's verdict agrees with the outcome the widget actually got.
 */
export function enrichObservation(
  raw: RawObservation,
  declared: readonly Capability[],
  seq: number,
): SdkObservation {
  const required = requiredCapability({ method: raw.method, args: [raw.arg] });
  if (required === null) {
    return {
      seq,
      method: raw.method,
      api: null,
      capability: null,
      outcome: raw.outcome,
      declared: true,
      violation: false,
      grantedBy: null,
    };
  }
  const granting = grantingCapability(declared, required);
  return {
    seq,
    method: raw.method,
    api: required.api,
    capability: formatCapability(toCapability(required)),
    outcome: raw.outcome,
    declared: granting !== null,
    violation: granting === null,
    grantedBy: granting !== null ? formatCapability(granting) : null,
  };
}

/** The most calls one mount session keeps; a runaway widget drops its oldest, never grows unbounded. */
const MAX_CALLS = 1000;

/**
 * The observed-call log for the current mount. Bounded and reset per mount: a
 * source/manifest reload (which re-mounts the widget with a fresh SDK) clears it,
 * so the panel always reflects the *current* code's behavior, never a stale
 * accumulation across edits.
 */
export class InspectorLog {
  #calls: SdkObservation[] = [];
  #seq = 0;

  /** Record one reported call against the live `declared` capabilities; returns the enriched entry. */
  add(raw: RawObservation, declared: readonly Capability[]): SdkObservation {
    const observation = enrichObservation(raw, declared, this.#seq++);
    this.#calls.push(observation);
    if (this.#calls.length > MAX_CALLS) this.#calls.shift();
    return observation;
  }

  /** Every observed call this session, in arrival order (a defensive copy). */
  list(): readonly SdkObservation[] {
    return this.#calls.slice();
  }

  /** Drop every observed call and restart the ordinal — a new mount session begins. */
  clear(): void {
    this.#calls = [];
    this.#seq = 0;
  }
}

/** The live values the server injects into an inspector render. */
export interface InspectorConfig {
  /** The widget's custom-element tag (from the manifest). */
  readonly tag: string;
  /** Whether the mount runs on fixtures or forwards to a `--proxy` host. */
  readonly mode: 'fixture' | 'proxy';
}

/**
 * Render the standalone SDK-inspector page. A single self-contained document
 * (inline CSS + JS, no framework, no external fetch beyond the dev server): it
 * loads the current {@link InspectorSession} from `GET /@dev/inspect`, then follows
 * the shared SSE channel — appending each `inspect` frame and clearing on a
 * `reload` frame (a re-mount starts a fresh session). Pure string builder; the
 * server serves the result.
 */
export function renderInspector(config: InspectorConfig): string {
  const boot = { tag: config.tag, mode: config.mode, endpoints: ENDPOINTS };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>gridmason dev — SDK inspector — ${escapeHtml(config.tag)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; --line: #8883; }
  body { margin: 0; padding: 16px; font-size: 14px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 20px 0 6px; }
  .sub { opacity: .7; margin: 0 0 8px; font: 12px/1.4 ui-monospace, monospace; }
  table { border-collapse: collapse; width: 100%; font: 13px/1.5 ui-monospace, monospace; }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; opacity: .7; }
  .muted { opacity: .55; }
  .pill { display: inline-block; padding: 0 6px; border-radius: 999px; font-size: 11px; border: 1px solid var(--line); }
  .out-fixture-hit { color: #27ae60; }
  .out-default-empty { color: #d98e00; }
  .out-denied { color: #c0392b; }
  .out-proxy-error { color: #c0392b; }
  tr.violation td { background: #c0392b18; }
  tr.empty td { background: #d98e0014; }
  .used { color: #27ae60; }
  .unused { color: #d98e00; }
  .none { opacity: .55; font-style: italic; }
</style>
</head>
<body>
<h1>SDK inspector — ${escapeHtml(config.tag)}</h1>
<p class="sub">mode: ${escapeHtml(config.mode)} · declared capabilities vs the gated SDK calls the widget made</p>

<h2>Declared capabilities</h2>
<div id="caps"></div>

<h2>Observed SDK calls</h2>
<div id="calls"></div>

<script type="module">
const BOOT = ${JSON.stringify(boot)};
${clientScript()}
</script>
</body>
</html>
`;
}

/** The inspector client, embedded verbatim — plain browser ESM, no imports. */
function clientScript(): string {
  return `
const { endpoints } = BOOT;
const capsEl = document.getElementById('caps');
const callsEl = document.getElementById('calls');

let declared = [];
let calls = [];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Which declared capabilities were exercised by a non-violating call this session. */
function usedSet() {
  const used = new Set();
  for (const call of calls) if (call.grantedBy) used.add(call.grantedBy);
  return used;
}

function renderCaps() {
  if (declared.length === 0) {
    capsEl.innerHTML = '<p class="none">The manifest declares no capabilities.</p>';
    return;
  }
  const used = usedSet();
  const rows = declared.map((cap) => {
    const isUsed = used.has(cap);
    return '<tr><td>' + esc(cap) + '</td><td class="' + (isUsed ? 'used' : 'unused') + '">'
      + (isUsed ? 'used' : 'not yet used') + '</td></tr>';
  }).join('');
  capsEl.innerHTML = '<table><thead><tr><th>Capability</th><th>This session</th></tr></thead><tbody>'
    + rows + '</tbody></table>';
}

function renderCalls() {
  if (calls.length === 0) {
    callsEl.innerHTML = '<p class="none">No gated SDK calls observed yet — interact with the widget in the harness tab.</p>';
    return;
  }
  const rows = calls.map((call) => {
    const cls = call.violation ? 'violation' : (call.outcome === 'default-empty' ? 'empty' : '');
    const declaredCell = call.violation
      ? '<span class="pill out-denied">undeclared</span>'
      : '<span class="muted">declared</span>';
    return '<tr class="' + cls + '">'
      + '<td class="muted">' + call.seq + '</td>'
      + '<td>' + esc(call.method) + '</td>'
      + '<td>' + (call.capability ? esc(call.capability) : '<span class="muted">—</span>') + '</td>'
      + '<td>' + declaredCell + '</td>'
      + '<td class="out-' + esc(call.outcome) + '">' + esc(call.outcome) + '</td>'
      + '</tr>';
  }).join('');
  callsEl.innerHTML = '<table><thead><tr><th>#</th><th>Method</th><th>Capability</th>'
    + '<th>Declared</th><th>Outcome</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function render() { renderCaps(); renderCalls(); }

/** Load the current session (declared capabilities + calls so far) — on open and on every re-mount. */
async function refresh() {
  try {
    const res = await fetch(endpoints.inspect, { cache: 'no-store' });
    const session = await res.json();
    declared = session.declared || [];
    calls = session.calls || [];
  } catch {
    declared = [];
    calls = [];
  }
  render();
}

const source = new EventSource(endpoints.events);
// A new gated call the harness (or proxy) observed — append it live.
source.addEventListener('inspect', (ev) => {
  try { calls.push(JSON.parse(ev.data)); render(); } catch {}
});
// A re-mount (source/manifest reload, or a fixture/context hot-swap) starts a
// fresh session; re-pull the cleared server session and the live declared caps.
source.addEventListener('reload', () => { refresh(); });

refresh();
`;
}

/** Escape a string for safe interpolation into HTML text/attribute context. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
