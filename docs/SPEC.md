# SPEC — `@gridmason/cli` (the `gridmason` binary)

**Repo:** `gridmason/cli` · **Package:** `@gridmason/cli` · **Binary:** `gridmason` (GW-D11) · **License:** AGPL-3.0 (CLA required) · **Status:** reviewed 2026-07-13 · **Project:** [Gridmason](https://github.com/gridmason/.github)

The widget-author devkit and the publish path into a Gridmason Registry. One binary spans the whole author loop: **scaffold → develop → lint → publish**. The CLI runs the **identical automated checks a registry review runs** (registry §4) locally, so "green locally" predicts "passes review" — no secret rules, no surprise rejections. It is also the reference client for the registry's publish/verify APIs (registry §8).

> **M1 committed** (README build order): `widget init / dev / lint` + **local signature/hash verify** — needed by registry M1 (drives the format work) and the dashboard dev loop (dashboard §4). `publish` lands with **registry M2** (the publish + verify pipeline).

## 1. Scope

**In:** project scaffolding (`init`); the local dev server + hot-load loop (`dev`); the local review checks (`lint`, byte-identical to registry automated review); local artifact verification (`verify` — signature chain + hash + log inclusion via `@gridmason/protocol`); the publish flow (`publish` — keyless signing, upload, review-status polling, appeal); config + registry targeting; offline-bundle produce/inspect (`bundle`).

**Out (explicit non-goals):** the registry service itself (that is `gridmason/registry`); browser runtime/loading (host shell); private-key custody design (keyless-by-default sidesteps it; the CLI orchestrates Sigstore, it is not a key vault); building the widget's framework bundle (the CLI drives the author's chosen bundler toward plain-ESM output, it is not a bundler — and the vanilla template needs no bundler at all, GW-D22).

## 2. Command surface

```
gridmason widget init [name]     scaffold a widget/plugin/page-type/layout project
gridmason dev                    local dev server; serves the remote for dashboard `dev` sideload
gridmason lint [--registry <url>] run the exact automated review checks locally
gridmason verify <artifact|url>  verify signature chain + content hash + log inclusion (offline-capable)
gridmason publish [--registry <url>]  sign (keyless) + upload + poll review status
gridmason appeal <artifact>      request a second reviewer (registry §4)
gridmason bundle export|inspect  produce/inspect a signed offline .gmb bundle (registry §3)
gridmason whoami | login         OIDC identity used for keyless signing
```

`widget` is the noun namespace (mirrors the manifest `kind`: `widget`/`plugin`/`page-type`/`layout`). Global flags: `--registry` (defaults to config → flagship), `--json` (machine output for CI), `--offline` (verify/bundle without network).

## 3. `init` — scaffolding

Generates a ready-to-develop project wired to the contracts:

- Manifest stub (protocol §3.1) with a **publisher-prefixed tag** (prompts for/reads the publisher prefix; enforces the lint rule at creation, not just at publish).
- A custom-element skeleton implementing the widget ABI (core §4): `context`/`settings`/`instance-id`/`edit-mode` attrs in, `CustomEvent`s out, SDK handle consumed via `@gridmason/sdk` helpers.
- Framework templates: **vanilla** (reference; bundler-free — a hand-written ES module), **React**, **Vue** (heritage from `vue3-widget-template`) — each producing a plain **ES-module `entry`** that registers the element (GW-D22; any ESM-emitting bundler works). Framework choice sets `sharedScope` defaults in the manifest.
- A JSON-schema'd `props` file, a `thumbnail` placeholder, a Storybook story stub, and a CI workflow calling `gridmason lint --registry` (fail the PR before review ever sees it).
- A `fixtures/` directory seeded from the manifest: one sample record per declared `requiresContext` recordType, an empty `net` stub per declared `net:<host>` capability, and a default context preset — `gridmason dev` renders with data on first run, before the author writes anything.

## 4. `dev` — the author loop (dashboard `dev` sideload)

- Serves the widget's `entry` module on localhost; the Gridmason Dashboard in `dev` mode hot-loads it via its **per-session allowlist** (dashboard §4) — nothing persisted, dev CSP adds the localhost origin only while the dev gate is on.
- Hot-reload on source change; live manifest re-validation; a mounted **SDK inspector** panel showing every capability the widget declared vs every SDK call it actually made (so an author sees an undeclared reach *before* review flags it).
- `dev` is a real driver of the SDK **fixture implementation** (sdk §5): the dev host mounts the widget with typed context, settings, *and data* supplied from the project's `fixtures/` directory — `records` (record-ref → record, query → list), `net` (host+path → response), `events` (scripted emissions), plus named **context presets** (`--context customer-42`) so one widget is exercised against several page contexts without a host. Fixtures hot-reload like source. Unmatched calls fall through to typed-empty defaults and show as *default-empty* in the SDK inspector — an author sees exactly which data paths their fixtures don't cover yet.
- **No backend required, ever, in the dev loop**: fixture SDK for offline work; `--proxy <host-url>` forwards SDK calls to a real running host (capability checks still enforced) when integration realism is needed. The dev server itself is never a data backend — data comes from fixtures or the proxy target, keeping the CLI out of the persistence business.

## 5. `lint` — review checks, run locally (the trust bridge)

Runs the **same automated checks the registry runs** (registry §4.1) so local-green predicts review-pass:

1. **Manifest lint** — schema-valid (protocol §3.1), **publisher-prefix** on the tag, `size`/context/capability shapes, `requires` well-formed.
2. **SDK-adherence static analysis** — flags raw network I/O outside the SDK, token reachability, and obfuscation heuristics (registry §4.1). This is the check most likely to fail a naive widget; surfacing it locally is the point.
3. **Capability diff** — against the previously-published version (with `--registry`): a capability *increase* is reported as "will re-trigger review" (registry §4).
4. **Dependency-DAG check** — `requires` graph acyclic; `--registry` validates it against the target registry pre-release (registry §7) so a cycle fails in CI, not at publish.
5. **DOM-abuse heuristics** for frontend remotes (TF tier, registry §4.2).

`--json` emits a structured report for CI gating. Every check maps to a registry review tier so the author knows which SLA their artifact will hit.

## 6. `verify` — local trust, offline-capable

The CLI is a first-class consumer of the `@gridmason/protocol` verification library (protocol §5): given an artifact or a remote URL plus pinned trust roots, it checks **dual signature + content hash + transparency-log inclusion** and prints a stable-enum verdict. `--offline` verifies a `.gmb` bundle against pinned roots with embedded inclusion proofs (protocol §4.5) — the same chain a host runs, on the author's machine. This is what makes "the reviewed hash is the runnable artifact" auditable by anyone, not just the registry.

## 7. `publish` — sign + upload (lands with registry M2)

1. `gridmason login` establishes the **OIDC identity** (the real trust anchor, registry §2); `publish` performs **keyless Sigstore-style signing** — a short-lived cert bound to that identity, recorded with issuer + subject claims in the signature envelope (protocol §4.2). No long-lived private key on the author's machine by default.
2. Uploads the immutable, content-hashed artifact (manifest + `entry` module + chunks + schemas + docs) to the target registry's Publish API (registry §8).
3. Polls review status; on pass, the registry countersigns + logs + CDN-publishes. On fail, prints the reviewer's findings mapped to the same `lint` check ids. `appeal` routes to a second reviewer.
4. Refuses to publish an artifact that would not pass local `lint` (fail fast; never upload known-bad).

## 8. Security posture

- The CLI **verifies with `@gridmason/protocol` and signs with standard Sigstore tooling** — it holds no bespoke crypto and, by keyless default, no long-lived key. `login`/`whoami` surface exactly which OIDC identity will vouch for an artifact.
- `lint` is deliberately the **same code path** the registry's automated review runs (shared package or shared checks module) — divergence between local and server checks is a bug, tested by shared conformance vectors (protocol §6).
- Local `verify` never trusts a root fetched blind (protocol §4.4); roots are pinned/config-supplied, matching host rules.
- `publish` fails closed: a manifest that fails lint, a cyclic `requires`, or an undeclared capability reach cannot be uploaded.

## 9. Package + repo

- Publishes `@gridmason/cli` (Node binary, ESM; installable via `npm i -g @gridmason/cli` or `npx`; SemVer). **License: AGPL-3.0 (GW-D8); all contributions require the CLA.**
- Repo: `src/commands`, `src/checks` (the shared lint/review checks), `src/templates` (init scaffolds), `src/publish`. Unit tests per check with the protocol conformance vectors; an e2e that scaffolds → lints → dev-serves → (with a local registry) publishes → verifies.
- Depends on: `@gridmason/protocol` (verify lib, manifest schema, formats), `@gridmason/sdk` (scaffold templates + the `dev` no-op host), the author's bundler (any ESM-emitting one, or none), standard Sigstore/OIDC client libs. No dependency on `core` or `dashboard`.

## 10. Milestones

1. **M1 — author loop** (committed): `init` (vanilla/React/Vue templates) + `dev` (dashboard `dev`-mode hot-load, SDK inspector) + `lint` (all automated checks) + `verify` (local, offline-capable). Unblocks the dashboard dev loop and drives the registry M1 format work.
2. **M2 — publish** (with registry M2): `login`/`whoami`, keyless signing, upload, review-status polling, `appeal`.
3. **M3 — bundles + registry-aware lint**: `bundle export|inspect`, `lint --registry` capability-diff + DAG checks against a live registry.
4. Exit: an author scaffolds, develops against the dashboard, lints clean, and publishes a widget that a host loads end-to-end — the full author-to-runtime loop on one binary.
