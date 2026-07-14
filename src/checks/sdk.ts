/**
 * SDK-adherence static analysis (SPEC §5.2, FR-7) — "would the registry's
 * automated review accept how this widget reaches the outside world?", run
 * locally. A conforming widget does all privileged I/O through the
 * capability-scoped SDK handle the host assigns to it; these three checks flag
 * the code that does not:
 *
 * - `sdk.raw-network` — raw network I/O outside the SDK (global `fetch`,
 *   `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`). A
 *   `fail`: this is the check most likely to fail a naive widget, and surfacing
 *   it locally before review is the point (SPEC §5).
 * - `sdk.token-reach` — reaching ambient credential/storage surfaces the widget
 *   must not touch directly (`document.cookie`, Web Storage, `indexedDB`,
 *   `window.name`); the widget only ever gets scoped data through its handle.
 * - `sdk.obfuscation` — patterns that hide the above from static reading
 *   (`eval`/`Function`, `atob`/`fromCharCode` decode chains, computed access on
 *   the global object, dynamic `import()` of a computed specifier, string-timer
 *   eval).
 *
 * **Heuristics only (v0).** Each rule is a regex over a comment/string-masked
 * view of the source (see {@link maskNonCode}); each carries a documented
 * known-bypass in `docs/checks.md`. The spec is explicit that v0 does not claim
 * static analysis is complete — aliasing, reflection, and runtime-assembled
 * strings evade these rules by construction. They catch the honest mistake and
 * the lazy evasion, not a determined one.
 */
import { runSourceRules, type SourceRule } from './source-scan.js';
import type { Check, CheckResult } from './types.js';

const NET_HINT =
  'do network I/O through the capability-scoped SDK handle (declare a `net:<host>` capability); ' +
  'the registry rejects raw network access outside the SDK.';
const TOKEN_HINT =
  'a widget receives host data only through its SDK handle; reading ambient browser credential/' +
  'storage surfaces (cookies, Web Storage, indexedDB) is outside the sandbox and fails review.';
const OBF_HINT =
  'remove the dynamic-code / decoding indirection so the checks (and a human reviewer) can read ' +
  'what the widget does; obfuscation that hides network or DOM access is a review rejection.';

/** `sdk.raw-network` rules: network egress that does not go through the SDK. */
const rawNetworkRules: readonly SourceRule[] = [
  // A bare global `fetch(` — not `sdk.fetch(` / `x.fetch(` (a `.` before it) and
  // not `myFetch(` (a word char before it).
  { pattern: /(?<![.\w$])fetch\s*\(/, status: 'fail', label: 'direct fetch() — raw network I/O outside the SDK', hint: NET_HINT },
  { pattern: /\b(?:window|self|globalThis)\.fetch\s*\(/, status: 'fail', label: 'fetch() on the global object — raw network I/O outside the SDK', hint: NET_HINT },
  { pattern: /\bnew\s+(?:(?:window|self|globalThis)\.)?XMLHttpRequest\b/, status: 'fail', label: 'XMLHttpRequest — raw network I/O outside the SDK', hint: NET_HINT },
  { pattern: /\bnew\s+(?:(?:window|self|globalThis)\.)?WebSocket\b/, status: 'fail', label: 'WebSocket — raw network I/O outside the SDK', hint: NET_HINT },
  { pattern: /\bnew\s+(?:(?:window|self|globalThis)\.)?EventSource\b/, status: 'fail', label: 'EventSource — raw network I/O outside the SDK', hint: NET_HINT },
  { pattern: /\.sendBeacon\s*\(/, status: 'fail', label: 'navigator.sendBeacon() — raw network I/O outside the SDK', hint: NET_HINT },
];

/** `sdk.token-reach` rules: ambient credential/storage surfaces off-limits to a widget. */
const tokenReachRules: readonly SourceRule[] = [
  { pattern: /\bdocument\.cookie\b/, status: 'fail', label: 'document.cookie — ambient credential store outside the SDK sandbox', hint: TOKEN_HINT },
  { pattern: /(?<![.\w$])(?:local|session)Storage\b/, status: 'fail', label: 'Web Storage — ambient store outside the SDK sandbox', hint: TOKEN_HINT },
  { pattern: /\b(?:window|self|globalThis)\.(?:local|session)Storage\b/, status: 'fail', label: 'Web Storage on the global object — ambient store outside the SDK sandbox', hint: TOKEN_HINT },
  { pattern: /(?<![.\w$])indexedDB\b/, status: 'warn', label: 'indexedDB — ambient store outside the SDK sandbox', hint: TOKEN_HINT },
  { pattern: /\b(?:window|self|globalThis)\.indexedDB\b/, status: 'warn', label: 'indexedDB on the global object — ambient store outside the SDK sandbox', hint: TOKEN_HINT },
  { pattern: /\bwindow\.name\b/, status: 'warn', label: 'window.name — ambient cross-navigation channel', hint: TOKEN_HINT },
];

/** `sdk.obfuscation` rules: indirection that hides network/DOM access from static reading. */
const obfuscationRules: readonly SourceRule[] = [
  { pattern: /(?<![.\w$])eval\s*\(/, status: 'fail', label: 'eval() — dynamic code execution', hint: OBF_HINT },
  { pattern: /\bnew\s+Function\s*\(/, status: 'fail', label: 'new Function() — dynamic code execution', hint: OBF_HINT },
  { pattern: /(?<![.\w$])Function\s*\(\s*['"]/, status: 'fail', label: 'Function() constructor with a string body — dynamic code execution', hint: OBF_HINT },
  // `import(` whose first non-space char is not a quote → a computed specifier.
  { pattern: /\bimport\s*\(\s*(?!['"])/, status: 'warn', label: 'dynamic import() with a computed specifier', hint: OBF_HINT },
  // Computed access on the global object with a non-literal key (`window[x]`).
  { pattern: /\b(?:window|globalThis|self|document)\s*\[\s*(?!['"\d\]])/, status: 'warn', label: 'computed member access on a global object (dynamic property name)', hint: OBF_HINT },
  // String-built key on the global object (`window['fe'+'tch']`).
  { pattern: /\b(?:window|globalThis|self|document)\s*\[[^\]]*\+/, status: 'warn', label: 'string-built member access on a global object', hint: OBF_HINT },
  { pattern: /(?<![.\w$])atob\s*\(/, status: 'warn', label: 'atob() base64 decode (can conceal a payload)', hint: OBF_HINT },
  { pattern: /\bString\.fromCharCode\s*\(/, status: 'warn', label: 'String.fromCharCode() (can conceal a payload)', hint: OBF_HINT },
  { pattern: /(?<![.\w$])unescape\s*\(/, status: 'warn', label: 'unescape() (can conceal a payload)', hint: OBF_HINT },
  { pattern: /\b(?:setTimeout|setInterval)\s*\(\s*['"]/, status: 'warn', label: 'setTimeout/setInterval with a string argument (string eval)', hint: OBF_HINT },
];

/** `sdk.raw-network` — network egress that does not go through the SDK handle. */
export const sdkRawNetworkCheck: Check = {
  id: 'sdk.raw-network',
  title: 'sdk raw network',
  rationale:
    'A widget performs network I/O only through its capability-scoped SDK handle, so the host can ' +
    'gate and audit it. This check flags raw egress the SDK cannot see — global fetch, ' +
    'XMLHttpRequest, WebSocket, EventSource, sendBeacon — the pattern most likely to fail review.',
  run(ctx): CheckResult[] {
    return runSourceRules(this.id, ctx.sourceFiles ?? [], rawNetworkRules, 'no raw network I/O outside the SDK');
  },
};

/** `sdk.token-reach` — reaching ambient credential/storage surfaces off-limits to a widget. */
export const sdkTokenReachCheck: Check = {
  id: 'sdk.token-reach',
  title: 'sdk token reachability',
  rationale:
    'A widget only ever receives scoped host data through its SDK handle. This check flags code ' +
    'that reaches ambient credential/storage surfaces directly — document.cookie, Web Storage, ' +
    'indexedDB, window.name — which sit outside the sandbox the handle defines.',
  run(ctx): CheckResult[] {
    return runSourceRules(this.id, ctx.sourceFiles ?? [], tokenReachRules, 'no ambient credential/storage reach outside the SDK');
  },
};

/** `sdk.obfuscation` — indirection that hides network/DOM access from static reading. */
export const sdkObfuscationCheck: Check = {
  id: 'sdk.obfuscation',
  title: 'sdk obfuscation',
  rationale:
    'Static SDK-adherence checks only see code they can read. This check flags the indirection that ' +
    'defeats reading — eval/Function, base64/char-code decoding, computed access on the global ' +
    'object, dynamic import of a computed specifier — so hidden network or DOM access is surfaced.',
  run(ctx): CheckResult[] {
    return runSourceRules(this.id, ctx.sourceFiles ?? [], obfuscationRules, 'no code-obfuscation patterns found');
  },
};

/** The SDK-adherence checks (SPEC §5.2), in report order. */
export const sdkChecks: readonly Check[] = [sdkRawNetworkCheck, sdkTokenReachCheck, sdkObfuscationCheck];
