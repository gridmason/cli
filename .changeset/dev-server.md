---
"@gridmason/cli": patch
---

Implement `gridmason dev`: the local author loop (SPEC §4, FR-4/FR-5). A localhost
HTTP server serves the widget's plain-ESM `entry` for the Gridmason Dashboard's
`dev` sideload and a standalone fixture harness that mounts the widget on the SDK
fixture implementation (`createFixtureSDK`), with live manifest re-validation and
hot reload on every `src/` / `manifest.json` / `fixtures/` edit. `--context <name>`
mounts a `fixtures/contexts/<name>.json` page-context preset (overriding the
default context while records/net/events stay from `default.json`); `--proxy
<host-url>` forwards SDK calls to a real running host with capability checks still
enforced — a capability the manifest does not declare stays denied through the
proxy, and a denied call never reaches the target. The dev server is never a data
backend: every datum comes from a fixture file or the proxy target, and all
project state is read fresh from disk per request. Resolves the spec's open
hot-reload question — cache-busting import URLs plus a scoped reload — documented
in `docs/dev-server.md`. Adds `chokidar` for file watching.
