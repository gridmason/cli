/**
 * The standalone **fixture harness** the `dev` server serves at `/` (SPEC §4).
 * It is the no-dashboard author loop: a minimal host page that mounts the
 * widget's custom element on the SDK **fixture implementation**
 * (`createFixtureSDK`, sdk §5) — or, under `--proxy`, on a thin client that
 * forwards SDK calls to the real host through the dev server — so one widget can
 * be exercised against its fixtures and named context presets with no host at
 * all. The Gridmason Dashboard's `dev` sideload is the *other* consumer (it
 * imports the entry and supplies its own host); this page is what makes the loop
 * work before a dashboard is in the picture.
 *
 * ## Hot-reload mechanism (the spec's open question, resolved)
 *
 * Plain-ESM modules are cached by URL and a custom element's tag can be defined
 * only once per document, so a live code swap cannot re-`import` the same URL and
 * expect a new element class. This harness resolves it with **cache-busting
 * import URLs plus a scoped reload**:
 *
 * - The server sends `Cache-Control: no-store` and, over the SSE stream
 *   (`/@dev/events`), a `reload` event tagged with what changed and a
 *   monotonically increasing generation token.
 * - A **source** or **manifest** change reloads the whole page; the server
 *   re-renders it with the new generation, so the entry is imported at a fresh
 *   `?v=<generation>` URL in a fresh document — new module graph, new class, no
 *   stale cache.
 * - A **fixtures** or **context** change never re-imports the module: the harness
 *   re-fetches the data, tears the element down, and re-mounts it on a new
 *   fixture SDK — instant data refresh with the code untouched.
 *
 * This module is a pure string builder (no I/O); the server injects the live
 * config and serves the result.
 */
import { ENDPOINTS } from './endpoints.js';

/** The live values the server injects into a harness render. */
export interface HarnessConfig {
  /** The widget's custom-element tag (from the manifest). */
  readonly tag: string;
  /** The URL the widget `entry` module is served at (project-relative → served path). */
  readonly entryUrl: string;
  /** The cache-busting generation token; bumped on every source/manifest reload. */
  readonly generation: number;
  /** `fixture` mounts on `createFixtureSDK`; `proxy` forwards SDK calls to the host. */
  readonly mode: 'fixture' | 'proxy';
}

/** Render the harness host page for the current project state. */
export function renderHarness(config: HarnessConfig): string {
  const bootstrap = {
    tag: config.tag,
    entryUrl: config.entryUrl,
    generation: config.generation,
    mode: config.mode,
    endpoints: ENDPOINTS,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>gridmason dev — ${escapeHtml(config.tag)}</title>
<script type="importmap">
${JSON.stringify(importMap(), null, 2)}
</script>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; }
  #gm-dev-bar { padding: 8px 12px; font: 13px/1.4 ui-monospace, monospace; border-bottom: 1px solid #8883; display: flex; gap: 12px; align-items: center; }
  #gm-dev-status[data-ok="false"] { color: #c0392b; }
  #gm-dev-status[data-ok="true"] { color: #27ae60; }
  #gm-dev-bar a { margin-left: auto; color: inherit; }
  #gm-dev-mount { padding: 16px; }
</style>
</head>
<body>
<div id="gm-dev-bar">
  <strong>${escapeHtml(config.tag)}</strong>
  <span id="gm-dev-status">loading…</span>
  <span id="gm-dev-mode">${config.mode}</span>
  <a href="${ENDPOINTS.inspector}" target="_blank" rel="noopener">SDK inspector ↗</a>
</div>
<div id="gm-dev-mount"></div>
<script type="module">
const BOOT = ${JSON.stringify(bootstrap)};
${clientScript()}
</script>
</body>
</html>
`;
}

/** The import map that resolves the browser-side `@gridmason/*` ESM. */
function importMap(): { imports: Record<string, string> } {
  const npm = ENDPOINTS.npm;
  return {
    imports: {
      '@gridmason/protocol': `${npm}@gridmason/protocol/dist/index.js`,
      '@gridmason/sdk/fixture': `${npm}@gridmason/sdk/dist/fixture/index.js`,
    },
  };
}

/**
 * The harness client, embedded verbatim. Plain browser ESM — it imports the
 * fixture SDK by the mapped bare specifier, mounts the widget, and wires the SSE
 * hot-reload loop described in this module's doc.
 */
function clientScript(): string {
  return `
const { endpoints } = BOOT;
const statusEl = document.getElementById('gm-dev-status');
const mountEl = document.getElementById('gm-dev-mount');

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(url + ' -> ' + res.status);
  return res.json();
}

/** Build the SDK handle: the fixture implementation, or a proxy client to the host. */
async function buildSdk(context) {
  const capabilities = await getJson(endpoints.capabilities);
  if (BOOT.mode === 'proxy') return proxySdk(capabilities, context);
  const { createFixtureSDK, getFixtureControls } = await import('@gridmason/sdk/fixture');
  const fixtures = await getJson(endpoints.fixtures);
  const sdk = createFixtureSDK(fixtures, { capabilities, context, instanceId: 'dev-1' });
  instrument(sdk, getFixtureControls);
  return sdk;
}

/**
 * Mirror every gated SDK call the widget makes to the SDK inspector. The fixture
 * SDK already tags each gated call on its shared recorder with a fixture outcome
 * ('fixture-hit'/'default-empty'/'denied'/'allowed'); we wrap that recorder's
 * \`record\` so the tag is reported to the dev server without touching the value the
 * widget receives — a pure feedback tap, no behavior change. Ungated calls carry
 * no outcome tag and are not reported (they bear no capability).
 */
function instrument(sdk, getFixtureControls) {
  let recorder;
  try { recorder = getFixtureControls(sdk).recorder; } catch { return; }
  const record = recorder.record.bind(recorder);
  recorder.record = (method, args, meta) => {
    const call = record(method, args, meta);
    const outcome = meta && meta.outcome;
    if (outcome) report(method, outcome, args && args[0]);
    return call;
  };
}

/** Fire-and-forget POST one observed gated call to the inspector channel. */
function report(method, outcome, arg) {
  let safeArg = null;
  try { safeArg = arg === undefined ? null : JSON.parse(JSON.stringify(arg)); } catch { safeArg = null; }
  fetch(endpoints.inspect, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, outcome, arg: safeArg }),
  }).catch(() => {});
}

/** A thin SDK whose gated calls POST to the dev server, which enforces + forwards. */
function proxySdk(capabilities, context) {
  const call = async (method, args) => {
    const res = await fetch(endpoints.sdk, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args }),
    });
    const body = await res.json();
    if (body.status === 'denied') throw new Error('PermissionDenied: ' + JSON.stringify(body.capability));
    if (body.status !== 'forwarded') throw new Error(body.message || 'proxy error');
    return body.value;
  };
  const noop = () => {};
  return {
    records: {
      read: (ref, opts) => call('records.read', [ref, opts].filter((a) => a !== undefined)),
      query: (spec) => call('records.query', [spec]),
      write: (ref, patch) => call('records.write', [ref, patch]),
    },
    net: { fetch: (req) => call('net.fetch', [req]) },
    events: { emit: () => call('events.emit', []).catch(noop), on: () => noop },
    context,
    settings: { get: () => ({}), update: () => call('settings.update', []).catch(noop), onSchema: noop },
    nav: { open: noop, toast: noop },
    telemetry: { error: noop, mark: noop },
    identity: { instanceId: 'dev-1', widgetId: { source: { kind: 'local' }, tag: BOOT.tag } },
  };
}

let mounted = null;

async function mount() {
  try {
    // Cache-busting import URL: a new generation forces a fresh module graph.
    await import(BOOT.entryUrl + '?v=' + BOOT.generation);
    const context = await getJson(endpoints.context);
    const manifest = await getJson(endpoints.manifest);
    statusEl.dataset.ok = String(manifest.valid);
    statusEl.textContent = manifest.valid ? 'manifest ok' : manifest.violations.join('; ');

    const sdk = await buildSdk(context.context || {});
    const el = document.createElement(BOOT.tag);
    el.setAttribute('context', JSON.stringify(context.context || {}));
    el.setAttribute('settings', '{}');
    el.setAttribute('instance-id', 'dev-1');
    mountEl.replaceChildren(el);
    el.sdk = sdk;
    mounted = el;
  } catch (err) {
    statusEl.dataset.ok = 'false';
    statusEl.textContent = 'mount failed: ' + (err && err.message || err);
  }
}

/** Re-mount with fresh data only (no module re-import) — for fixture/context edits. */
async function remountData() {
  if (!mounted) return mount();
  try {
    const context = await getJson(endpoints.context);
    const sdk = await buildSdk(context.context || {});
    const el = document.createElement(BOOT.tag);
    el.setAttribute('context', JSON.stringify(context.context || {}));
    el.setAttribute('settings', '{}');
    el.setAttribute('instance-id', 'dev-1');
    mountEl.replaceChildren(el);
    el.sdk = sdk;
    mounted = el;
  } catch (err) {
    statusEl.textContent = 'reload failed: ' + (err && err.message || err);
  }
}

const source = new EventSource(endpoints.events);
source.addEventListener('reload', (ev) => {
  let data = {};
  try { data = JSON.parse(ev.data); } catch {}
  // Source or manifest changes need the new module graph → full reload; the
  // server re-renders this page with a bumped generation. Data changes hot-swap.
  if (data.category === 'source' || data.category === 'manifest') location.reload();
  else remountData();
});

mount();
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
