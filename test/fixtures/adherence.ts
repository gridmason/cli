/**
 * Seeded-violation fixtures for the SDK-adherence + DOM-abuse checks (#12).
 *
 * Each case is a **planted-violation sample widget**: a minimal source file whose
 * one interesting line trips exactly one heuristic. The suite drives them two ways
 * (see `test/checks-sdk.test.ts`): the named check must catch its own sample, and
 * the *other* source checks must stay clean on it (no cross-talk). The clean
 * `gridmason init` templates are the negative half of the suite and live in the
 * test itself (generated via `planScaffold`), proving zero false positives.
 *
 * Kept as exported strings rather than on-disk `.js` so they are type-checked and
 * lint-clean as data — the violations live inside the `contents`, not in this
 * module's own code. Each header comment names the planted violation; comments are
 * masked before scanning, so they never affect a result.
 */
import type { SourceFile } from '../../src/checks/index.js';

/** A planted-violation sample and what the checks must make of it. */
export interface ViolationCase {
  /** Human name for the `it.each` row. */
  readonly name: string;
  /** The check id that must flag this sample. */
  readonly checkId: string;
  /** The severity that check must report. */
  readonly status: 'warn' | 'fail';
  /** A substring the finding's message (the offending token) must contain. */
  readonly tokenIncludes: string;
  /** The sample widget source. */
  readonly file: SourceFile;
}

/** Wrap a one-line violation in a tiny, plausible widget method body. */
function sample(path: string, header: string, body: string): SourceFile {
  return {
    path,
    contents: `// ${header}\nexport function run(sdk, el) {\n  ${body}\n}\n`,
  };
}

/** `sdk.raw-network` — network egress that does not go through the SDK handle. */
export const rawNetworkCases: readonly ViolationCase[] = [
  {
    name: 'global fetch()',
    checkId: 'sdk.raw-network',
    status: 'fail',
    tokenIncludes: 'fetch(',
    file: sample('src/net-fetch.js', 'planted: raw global fetch', "return fetch('/collect');"),
  },
  {
    name: 'window.fetch()',
    checkId: 'sdk.raw-network',
    status: 'fail',
    tokenIncludes: 'window.fetch(',
    file: sample('src/net-window-fetch.js', 'planted: fetch on the global object', "return window.fetch('/collect');"),
  },
  {
    name: 'new XMLHttpRequest()',
    checkId: 'sdk.raw-network',
    status: 'fail',
    tokenIncludes: 'XMLHttpRequest',
    file: sample('src/net-xhr.js', 'planted: XMLHttpRequest', 'const x = new XMLHttpRequest();'),
  },
  {
    name: 'new WebSocket()',
    checkId: 'sdk.raw-network',
    status: 'fail',
    tokenIncludes: 'WebSocket',
    file: sample('src/net-ws.js', 'planted: WebSocket', "const s = new WebSocket('wss://x');"),
  },
  {
    name: 'new EventSource()',
    checkId: 'sdk.raw-network',
    status: 'fail',
    tokenIncludes: 'EventSource',
    file: sample('src/net-sse.js', 'planted: EventSource', "const e = new EventSource('/stream');"),
  },
  {
    name: 'navigator.sendBeacon()',
    checkId: 'sdk.raw-network',
    status: 'fail',
    tokenIncludes: 'sendBeacon(',
    file: sample('src/net-beacon.js', 'planted: sendBeacon', "navigator.sendBeacon('/b', el.textContent);"),
  },
];

/** `sdk.token-reach` — reaching ambient credential/storage surfaces. */
export const tokenReachCases: readonly ViolationCase[] = [
  {
    name: 'document.cookie',
    checkId: 'sdk.token-reach',
    status: 'fail',
    tokenIncludes: 'document.cookie',
    file: sample('src/tok-cookie.js', 'planted: document.cookie', 'const c = document.cookie;'),
  },
  {
    name: 'localStorage',
    checkId: 'sdk.token-reach',
    status: 'fail',
    tokenIncludes: 'localStorage',
    file: sample('src/tok-local.js', 'planted: localStorage', "const t = localStorage.getItem('tok');"),
  },
  {
    name: 'sessionStorage',
    checkId: 'sdk.token-reach',
    status: 'fail',
    tokenIncludes: 'sessionStorage',
    file: sample('src/tok-session.js', 'planted: sessionStorage', "sessionStorage.setItem('t', el.id);"),
  },
  {
    name: 'indexedDB',
    checkId: 'sdk.token-reach',
    status: 'warn',
    tokenIncludes: 'indexedDB',
    file: sample('src/tok-idb.js', 'planted: indexedDB', "const db = indexedDB.open('w');"),
  },
  {
    name: 'window.name',
    checkId: 'sdk.token-reach',
    status: 'warn',
    tokenIncludes: 'window.name',
    file: sample('src/tok-winname.js', 'planted: window.name', 'const n = window.name;'),
  },
];

/** `sdk.obfuscation` — indirection that hides network/DOM access from static reading. */
export const obfuscationCases: readonly ViolationCase[] = [
  {
    name: 'eval()',
    checkId: 'sdk.obfuscation',
    status: 'fail',
    tokenIncludes: 'eval(',
    file: sample('src/obf-eval.js', 'planted: eval', 'return eval(el.dataset.code);'),
  },
  {
    name: 'new Function()',
    checkId: 'sdk.obfuscation',
    status: 'fail',
    tokenIncludes: 'new Function(',
    file: sample('src/obf-fn.js', 'planted: Function constructor', "const f = new Function('return 1');"),
  },
  {
    name: 'computed global member',
    checkId: 'sdk.obfuscation',
    status: 'warn',
    tokenIncludes: 'window[',
    file: sample('src/obf-computed.js', 'planted: computed global access', 'return window[el.dataset.k];'),
  },
  {
    name: 'string-built global member',
    checkId: 'sdk.obfuscation',
    status: 'warn',
    tokenIncludes: 'window[',
    file: sample('src/obf-concat.js', 'planted: string-built global access', "return window['fe' + 'tch'];"),
  },
  {
    name: 'dynamic import() of a computed specifier',
    checkId: 'sdk.obfuscation',
    status: 'warn',
    tokenIncludes: 'import(',
    file: sample('src/obf-import.js', 'planted: computed dynamic import', 'return import(el.dataset.mod);'),
  },
  {
    name: 'atob() decode',
    checkId: 'sdk.obfuscation',
    status: 'warn',
    tokenIncludes: 'atob(',
    file: sample('src/obf-atob.js', 'planted: base64 decode', 'return atob(el.dataset.p);'),
  },
  {
    name: 'setTimeout with a string body',
    checkId: 'sdk.obfuscation',
    status: 'warn',
    tokenIncludes: 'setTimeout(',
    file: sample('src/obf-timer.js', 'planted: string-eval timer', "setTimeout('doStuff()', 0);"),
  },
];

/** `dom.abuse` — a frontend remote reaching outside its own subtree. */
export const domAbuseCases: readonly ViolationCase[] = [
  {
    name: 'document.querySelector',
    checkId: 'dom.abuse',
    status: 'warn',
    tokenIncludes: 'document.querySelector',
    file: sample('src/dom-query.js', 'planted: document-wide query', "return document.querySelector('.host-secret');"),
  },
  {
    name: 'document.body',
    checkId: 'dom.abuse',
    status: 'warn',
    tokenIncludes: 'document.body',
    file: sample('src/dom-body.js', 'planted: document structural root', 'document.body.appendChild(el);'),
  },
  {
    name: 'document-level addEventListener',
    checkId: 'dom.abuse',
    status: 'warn',
    tokenIncludes: 'document.addEventListener',
    file: sample('src/dom-listener.js', 'planted: document-level listener', "document.addEventListener('click', () => {});"),
  },
  {
    name: 'window.open',
    checkId: 'dom.abuse',
    status: 'warn',
    tokenIncludes: 'window.open',
    file: sample('src/dom-open.js', 'planted: window.open', "window.open('https://x');"),
  },
  {
    name: 'top.location navigation',
    checkId: 'dom.abuse',
    status: 'warn',
    tokenIncludes: 'top.location',
    file: sample('src/dom-topnav.js', 'planted: cross-frame navigation', 'top.location = el.dataset.href;'),
  },
  {
    name: 'window.location assignment',
    checkId: 'dom.abuse',
    status: 'warn',
    tokenIncludes: 'window.location',
    file: sample('src/dom-winnav.js', 'planted: top-level navigation', 'window.location = el.dataset.href;'),
  },
];

/** Every planted-violation case, grouped by the check that owns it. */
export const violationCases: readonly ViolationCase[] = [
  ...rawNetworkCases,
  ...tokenReachCases,
  ...obfuscationCases,
  ...domAbuseCases,
];
