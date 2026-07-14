# @gridmason/cli

## 0.1.1

### Patch Changes

- 513ba36: Bump the `@gridmason/sdk` pin emitted by `widget init` (and the CLI's own dev dep) from `^0.3.0` to `^0.4.0` (#50).

  In 0.x semver `^0.3.0` excludes 0.4.x, so scaffolded projects were pinned off the current sdk. The 0.4.0 changes (per-instance token contract, `events:<ns>` capability-gating enforcement, telemetry-attribution helpers, unmount hardening) are additive and host/transport-facing; the widget-author helper surfaces the templates consume (`useRecord`, `useSettings`, `watchRecord`, `bindSettings`, `createNoopSDK`) are unchanged, so template bodies and `docs/templates.md` need no changes. The template load-harness and scaffold→lint e2e stay green against the real 0.4.0 adapters.

## 0.1.0

### Minor Changes

- 7c2fe2f: Export the seeded-violation lint fixture suite as `@gridmason/cli/checks/fixtures`.

  The planted-violation cases that drive the SDK-adherence and DOM-abuse checks
  now ship in `dist` and are importable alongside `@gridmason/cli/checks`, so
  consumers of the shared checks (the registry's automated review parity tests)
  can assert against the canonical suite instead of a vendored copy (#43).

- d3f6df6: Consume the published `@gridmason/sdk@0.3.0` framework adapters in the scaffold
  templates. The Vue template now imports the `@gridmason/sdk/vue` composables
  (`useRecord` / `useSettings`) and the vanilla template the `@gridmason/sdk/vanilla`
  helpers (`watchRecord` / `bindSettings`), replacing the interim direct binding to
  the `@gridmason/sdk` shared-core sources (`recordSource` / `settingsSource`); the
  React template already consumed `@gridmason/sdk/react`. The host-provided `.sdk`
  handle seam and the `createNoopSDK` first-run fallback are unchanged, as is the
  plain-ESM entry + `sharedScope` contract. Scaffolded projects now pin
  `@gridmason/sdk@^0.3.0`. Refs #25.

## 0.0.3

### Patch Changes

- a657fe4: Adopt `@gridmason/protocol@0.0.4`'s dev-proxy contract. The `--proxy` forward leg
  now consumes `DEV_PROXY_SDK_PATH` and the `DevProxySdkRequest` / `DevProxySdkResponse`
  types (with the `isDevProxySdkResponse` guard) from the protocol instead of
  re-declaring the path constant and request/response shapes locally, so `dev` and a
  host meet on one pinned wire contract. No behavior change: the capability gate still
  runs before any forward and an undeclared capability stays denied without reaching
  the target.

## 0.0.2

### Patch Changes

- 83af639: Add a scaffold→lint end-to-end gate and complete the check-id reference (FR-7,
  SPEC §5/§9).

  - **E2e (`npm run test:e2e`, `vitest.e2e.config.ts`):** drives the _built_ binary
    as a subprocess — `gridmason widget init` each starter template (vanilla /
    React / Vue, non-interactive flags) then `gridmason lint` the scaffold — and
    asserts a clean pass: exit 0, no failing check, and a `--json` report that
    validates against `schemas/lint-report.schema.json`. The binary is built once
    in the suite's `globalSetup`, so a regression in any check (or a template that
    drifts into tripping one) fails the gate. Wired into CI as a dedicated `e2e`
    job. This is the scaffold→lint leg of the SPEC §9 e2e; dev-serve/publish legs
    are Phase B.
  - **`docs/checks.md` is now the complete author-facing check-id reference:** every
    id carries its rationale, registry review tier, severity, and the exact fix
    hint the tool prints, alongside the honest known-bypass notes for the heuristic
    `sdk.*` / `dom.*` checks. Linked from the README and a new `docs/` index.

- eee6217: Add the local dependency-DAG check and the structured `gridmason lint --json`
  report with check-id → review-tier mapping (FR-7, #13). `deps.acyclic` proves the
  manifest's `requires` graph is acyclic offline — locally that catches a widget
  requiring its own tag, printing the cycle path; transitive, cross-manifest cycles
  stay the registry-validated `lint --registry` job (Phase B). `--json` now emits a
  report that serializes every check result and maps each to the registry review
  tier it feeds (registry §4.1–§4.2), with a `tiers` catalog resolving the SLAs, so
  a CI consumer learns which review SLA an artifact will hit. The tier mapping is
  data-driven by check-id `<group>` (`src/checks/tiers.ts`) — a new check family is a
  one-line addition. The report shape is owned here and pinned by the shipped JSON
  Schema `schemas/lint-report.schema.json`, which every emitted report validates
  against. See `docs/checks.md`.
- 0ef23f6: Add the shared checks module (`@gridmason/cli/checks`) and implement manifest
  lint for `gridmason lint` (FR-7, FR-8). The module is a plain library the
  registry service imports verbatim — one implementation, no divergence (SPEC §8).
  It ships three manifest checks — `manifest.schema` (authoritative
  `@gridmason/protocol` JSON Schema), `manifest.tag` (publisher-prefix + tag rules
  via `lintTag`), and `manifest.capabilities` (scope grammar via
  `validateCapability`) — driven by the protocol's shipped conformance vectors.
  `gridmason lint [path]` runs them with human and `--json` output and a
  fail-closed exit code. See `docs/checks.md` for the check-id scheme.
- 2c31973: Add the SDK-adherence and DOM-abuse static-analysis checks to `gridmason lint`
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

## 0.0.1

### Patch Changes

- 855a9df: Fix the `gridmason dev` fixture harness to resolve every `@gridmason/sdk` entry
  point a scaffolded widget imports. Since the templates began consuming the real
  SDK helpers, a vanilla `entry` imports `@gridmason/sdk` (shared-core
  `recordSource`/`settingsSource`) and `@gridmason/sdk/noop` (the fallback handle),
  but the harness import map only resolved `@gridmason/sdk/fixture` — so the
  standalone harness failed to mount with `Failed to resolve module specifier
"@gridmason/sdk"`. The import map now mirrors the SDK's export map
  (`@gridmason/sdk`, `/noop`, `/fixture`, `/vanilla`, `/react`, `/vue`), and a
  regression test asserts the harness resolves every `@gridmason/*` specifier each
  template imports.
- 5993ae2: Implement `gridmason dev`: the local author loop (SPEC §4, FR-4/FR-5). A localhost
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
- e2fe632: Seed `fixtures/` from the manifest on `widget init` (FR-3). `seedFixtures` derives
  a `FixtureFile` (shape owned by `@gridmason/sdk/fixture`) mechanically from the
  generated manifest: a `records.read` template + `records.query` list per
  `requiresContext` recordType, an empty `net` stub per `net:<host>` capability, a
  scripted emission per `events:<ns>` capability, and a default + named `contexts/`
  page-context preset — so the first `gridmason dev` renders with data before the
  author edits anything. Bumps `@gridmason/sdk` to `^0.2.0` (the version that ships
  the fixture schema) and, with it, the scaffold's declared `records.read` scope to
  the SDK's `recordType:<type>` grammar (`records.read:recordType:example`) so the
  scaffold's own reads pass capability enforcement — fixture-green predicts
  review-green.
- 0c5be77: Scaffold the `@gridmason/cli` package and the `gridmason` binary. Stands up a
  Node + TypeScript ESM package with a `commander`-based router covering the full
  SPEC §2 command surface (`widget init`, `dev`, `lint`, `verify`, `publish`,
  `appeal`, `bundle export|inspect`, `login`, `whoami`) and the global flags
  (`--registry`, `--json`, `--offline`). Commands are milestone-gated stubs that
  print a clear not-yet-implemented notice (`--json`-aware); `--help` documents the
  real surface. Includes the SPEC §9 repo skeleton (`src/commands`, `src/checks`,
  `src/templates`, `src/publish`), CI (build/typecheck/test/lint), changesets-based
  npm publishing, and the AGPL-3.0 + CLA governance files.
- 9aa0426: Add the `gridmason dev` **SDK inspector** (SPEC §4, FR-6): a standalone panel at
  `/@dev/inspector` (linked from the harness dev bar) that shows the capabilities
  the manifest declared against the gated SDK calls the widget actually made — so an
  author sees an **undeclared reach** (flagged as a violation, exactly what review
  would deny) and an **uncovered data path** (`default-empty` — allowed but no
  fixture matched) before publishing. The SDK fixture implementation already tags
  each gated call `fixture-hit` / `default-empty` / `denied` / `allowed`; the harness
  reports that tag to `POST /@dev/inspect`, the server enriches it with the required
  capability and whether the live manifest declares it (reusing the `--proxy`
  capability grammar), and broadcasts it to the panel over the existing SSE channel.
  `--proxy` mounts are recorded server-side from the same enforcement path. The
  panel changes no runtime behavior and serves no data — a pure author-feedback lens
  that resets each re-mount. Documented in `docs/dev-server.md`.
- 029bc8a: Fill the three `init` templates with real ABI skeletons: **vanilla**
  (bundler-free reference, GW-D22), **React**, and **Vue**. Each emits a plain
  ES-module `entry` that registers the widget's custom element and speaks the
  widget ABI (core §4) — the `context`/`settings`/`instance-id`/`edit-mode`
  attributes in, bubbling `CustomEvent`s (`gridmason:ready`, `gridmason:action`)
  out, and the capability-scoped host SDK handle read from `.sdk`.

  Consumes the real `@gridmason/sdk@^0.2.0` helpers: React uses the reference
  adapter `@gridmason/sdk/react` (`useRecord`, `useSettings`), while vanilla and Vue
  bind the framework-agnostic shared-core sources (`recordSource`, `settingsSource`)
  until the dedicated `@gridmason/sdk/{vanilla,vue}` adapters ship (SDK issue #10).
  Before a host wires a handle, the element falls back to `createNoopSDK` so the
  scaffold renders on first run. React and Vue author their component as plain ESM
  (no JSX/SFC) so the baseline entry loads with no build step; vanilla imports no
  framework runtime. A headless-DOM harness (`test/templates.test.ts`) loads each
  `entry` as a plain ES module and asserts it registers its tag, mounts, emits
  `gridmason:ready`, and drives a real SDK record read to resolution. Template
  contract documented in `docs/templates.md`.

- 5d1f733: Implement `gridmason widget init`: scaffold a widget/plugin/page-type/layout
  project (SPEC §3, FR-2). Prompts for (or reads as flags) the name, publisher
  prefix, kind, and framework, then writes a publisher-prefixed manifest stub —
  with the prefix rule enforced at creation via the protocol's `lintTag` — plus the
  framework `entry`, a draft-07 props schema, a thumbnail placeholder, a Storybook
  story stub, a CI workflow that runs `gridmason lint`, a `package.json`/README, and
  a seeded `fixtures/` directory. Template bodies (`src/templates`) and fixture
  seeding (`src/init/fixtures.ts`) are wired as extension seams for the follow-on
  issues. Command actions can now signal a non-zero exit code via `ExitCodeError`.
