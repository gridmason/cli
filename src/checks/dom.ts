/**
 * DOM-abuse heuristics for frontend remotes (SPEC §5.5, FR-7; registry §4.2, the
 * "TF" tier). A widget renders into its **own** subtree (the custom element / its
 * shadow root) and talks to the host through the ABI events, not by reaching into
 * the page around it. `dom.abuse` flags the reaches that break that boundary:
 *
 * - **document-wide queries** (`document.querySelector`, `getElementById`, …) and
 *   the document's **structural roots** (`document.body`/`head`/`documentElement`)
 *   — reading or walking outside the widget's own subtree;
 * - **document/window-level state** — `document.title`/`write`, `document`- or
 *   `window`-level event listeners (a page-wide hook, not an element-scoped one);
 * - **top navigation / cross-frame** — `window.open`, assigning `location`, and
 *   reaching `window.top`/`parent`/`opener` or `top`/`parent` `.location`/
 *   `.postMessage`.
 *
 * Element-scoped DOM is intentionally **not** flagged: `document.createElement`
 * (and the other `create*` factories), `customElements` registration, and
 * `element.addEventListener` on a node the widget owns are exactly how a
 * conforming widget (and every `gridmason init` template) builds its subtree —
 * so the clean scaffolds pass with zero findings.
 *
 * **Heuristics only (v0).** Rules run over a comment/string-masked view of the
 * source; each has a documented known-bypass in `docs/checks.md`. A reference held
 * in a variable (`const d = document; d.body`) or a name reached reflectively slips
 * past — these surface the plain reach for the reviewer, they do not prove its
 * absence. Every hit is a `warn`: DOM abuse is the TF tier's judgement call, so it
 * is surfaced locally without failing the gate on a heuristic alone.
 */
import { runSourceRules, type SourceRule } from './source-scan.js';
import type { Check, CheckResult } from './types.js';

const DOM_HINT =
  "keep DOM access inside the widget's own element/shadow subtree; document- or window-level reach, " +
  'top navigation, and cross-frame access are reviewed under the frontend (TF) tier.';

/**
 * `dom.abuse` rules. The `document.` rules enumerate the *reaching* members
 * explicitly rather than excluding the safe `create*` factories, so a new DOM API
 * is silent until deliberately added — a heuristic never grows teeth by accident.
 */
const domAbuseRules: readonly SourceRule[] = [
  {
    pattern: /\bdocument\.(?:querySelector|querySelectorAll|getElementById|getElementsByClassName|getElementsByTagName|getElementsByName|elementFromPoint|elementsFromPoint)\b/,
    status: 'warn',
    label: 'document-wide query reaches outside the widget subtree',
    hint: DOM_HINT,
  },
  { pattern: /\bdocument\.(?:body|head|documentElement)\b/, status: 'warn', label: 'reaches a document structural root outside the widget subtree', hint: DOM_HINT },
  { pattern: /\bdocument\.(?:title|write|writeln|execCommand|designMode)\b/, status: 'warn', label: 'mutates document-level state outside the widget', hint: DOM_HINT },
  { pattern: /\b(?:document|window)\.(?:add|remove)EventListener\s*\(/, status: 'warn', label: 'document/window-level event listener (outside the widget subtree)', hint: DOM_HINT },
  { pattern: /\bwindow\.open\s*\(/, status: 'warn', label: 'window.open() — opens a top-level browsing context', hint: DOM_HINT },
  { pattern: /\b(?:window|self)\.(?:top|parent|frames|frameElement|opener)\b/, status: 'warn', label: 'reaches a parent/top browsing context', hint: DOM_HINT },
  { pattern: /\b(?:top|parent)\.(?:location|postMessage)\b/, status: 'warn', label: 'cross-frame navigation/messaging', hint: DOM_HINT },
  { pattern: /\bwindow\.location\s*=[^=]/, status: 'warn', label: 'assigns window.location — top-level navigation', hint: DOM_HINT },
  { pattern: /\blocation\.(?:assign|replace)\s*\(/, status: 'warn', label: 'location.assign/replace — top-level navigation', hint: DOM_HINT },
  { pattern: /\blocation\.href\s*=[^=]/, status: 'warn', label: 'assigns location.href — top-level navigation', hint: DOM_HINT },
];

/** `dom.abuse` — a frontend remote reaching outside its own subtree (registry §4.2, TF tier). */
export const domAbuseCheck: Check = {
  id: 'dom.abuse',
  title: 'dom abuse',
  rationale:
    "A frontend widget renders into its own element/shadow subtree and reaches the host through the " +
    'ABI, not by walking the page. This check flags document-wide queries, document/window-level ' +
    'listeners and state, top navigation, and cross-frame access — the frontend (TF) tier concerns.',
  run(ctx): CheckResult[] {
    return runSourceRules(this.id, ctx.sourceFiles ?? [], domAbuseRules, 'no DOM access outside the widget subtree');
  },
};

/** The DOM-abuse checks (SPEC §5.5), in report order. */
export const domChecks: readonly Check[] = [domAbuseCheck];
