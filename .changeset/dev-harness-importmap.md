---
"@gridmason/cli": patch
---

Fix the `gridmason dev` fixture harness to resolve every `@gridmason/sdk` entry
point a scaffolded widget imports. Since the templates began consuming the real
SDK helpers, a vanilla `entry` imports `@gridmason/sdk` (shared-core
`recordSource`/`settingsSource`) and `@gridmason/sdk/noop` (the fallback handle),
but the harness import map only resolved `@gridmason/sdk/fixture` — so the
standalone harness failed to mount with `Failed to resolve module specifier
"@gridmason/sdk"`. The import map now mirrors the SDK's export map
(`@gridmason/sdk`, `/noop`, `/fixture`, `/vanilla`, `/react`, `/vue`), and a
regression test asserts the harness resolves every `@gridmason/*` specifier each
template imports.
