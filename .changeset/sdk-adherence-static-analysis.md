---
'@gridmason/cli': patch
---

Add the SDK-adherence and DOM-abuse static-analysis checks to `gridmason lint`
(FR-7, SPEC §5.2/§5.5). Four heuristic checks now run over the widget's own
source (`gridmason lint` collects the `src/` tree plus the manifest `entry`):
`sdk.raw-network` (raw `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/
`sendBeacon` outside the SDK — a failure), `sdk.token-reach` (ambient
credential/storage surfaces — `document.cookie`, Web Storage, `indexedDB`,
`window.name`), `sdk.obfuscation` (`eval`/`Function`, decode chains, computed
global access, dynamic `import()`), and `dom.abuse` (a frontend remote reaching
outside its own subtree — advisory warnings for the registry TF tier).

`CheckContext` gains an optional `sourceFiles` field (additive; manifest-only
consumers are unaffected). The checks scan a comment/string-masked view of the
source, so the clean `init` templates pass with zero false positives. v0 is
heuristics-only: every rule's known bypasses are documented in `docs/checks.md`.
