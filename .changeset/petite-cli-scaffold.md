---
"@gridmason/cli": patch
---

Scaffold the `@gridmason/cli` package and the `gridmason` binary. Stands up a
Node + TypeScript ESM package with a `commander`-based router covering the full
SPEC §2 command surface (`widget init`, `dev`, `lint`, `verify`, `publish`,
`appeal`, `bundle export|inspect`, `login`, `whoami`) and the global flags
(`--registry`, `--json`, `--offline`). Commands are milestone-gated stubs that
print a clear not-yet-implemented notice (`--json`-aware); `--help` documents the
real surface. Includes the SPEC §9 repo skeleton (`src/commands`, `src/checks`,
`src/templates`, `src/publish`), CI (build/typecheck/test/lint), changesets-based
npm publishing, and the AGPL-3.0 + CLA governance files.
