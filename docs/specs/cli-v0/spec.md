---
name: Gridmason CLI v0
slug: cli-v0
status: approved
created: 2026-07-13
approved: 2026-07-13
---

# Gridmason CLI v0

## Overview

`@gridmason/cli` ships the `gridmason` binary: the widget-author devkit (scaffold → develop → lint) and, in Phase B, the publish path into a Gridmason Registry (keyless signing, upload, review polling) plus local verification. `lint` runs the identical automated checks a registry review runs — local-green predicts review-pass.

Full engineering spec: [`docs/SPEC.md`](../../SPEC.md). **Phase A:** `init` / `dev` / `lint` with the fixture-SDK dev loop. **Phase B:** `login` / `publish` / `verify` / `appeal` / `bundle` / registry-aware lint.

## Goals

- An author goes from nothing to a running widget against the dashboard in under 10 minutes (`init` → `dev`).
- No backend ever required in the dev loop: fixtures by default, `--proxy` for realism.
- The shared checks module is literally the code the registry runs (Phase B) — no divergence.

## Non-goals

- Not a bundler (drives the author's ESM-emitting bundler; vanilla template is bundler-free, GW-D22). Not a key vault (keyless Sigstore). Not the registry service.

## Users & personas

- **Widget authors** — the whole loop.
- **Widget-repo CI** — `lint --json` gate.
- **Registry operators/auditors** — `verify` (B).

## Functional requirements

- **FR-1** Command surface per SPEC §2: `widget init`, `dev`, `lint`, `verify`, `publish`, `appeal`, `bundle export|inspect`, `login`/`whoami`; global `--registry`, `--json`, `--offline`.
- **FR-2** `init`: manifest stub with publisher-prefixed tag (prompted, lint-enforced at creation); ABI-conformant custom-element skeleton consuming `@gridmason/sdk` helpers; vanilla (bundler-free) / React / Vue templates emitting a plain ES-module `entry`; JSON-schema `props`, thumbnail placeholder, story stub, CI workflow calling `gridmason lint` (SPEC §3).
- **FR-3** `init` seeds `fixtures/`: sample record per declared `requiresContext` recordType, net stub per `net:<host>` capability, default context preset — first `dev` run renders with data (SPEC §3).
- **FR-4** `dev`: serves the `entry` module on localhost for the dashboard's per-session dev sideload; hot reload; live manifest re-validation (SPEC §4).
- **FR-5** `dev` mounts the widget on the SDK fixture implementation: fixtures hot-reload, named context presets (`--context`), `--proxy <host-url>` forwards SDK calls with capability checks intact; dev server is never a data backend (SPEC §4).
- **FR-6** SDK inspector: declared capabilities vs actual SDK calls, fixture-hit vs default-empty per call (SPEC §4).
- **FR-7** `lint` checks (SPEC §5): manifest schema + publisher prefix + shapes; SDK-adherence static analysis (raw network I/O, token reachability, obfuscation heuristics); local dependency-DAG acyclicity; DOM-abuse heuristics; `--json` structured report mapping check ids → review tiers.
- **FR-8** Checks live in a shared module (`src/checks`) importable by the registry service (B) — one implementation (SPEC §8).
- **FR-9** `verify`: dual signature + content hash + log inclusion via `@gridmason/protocol`, stable-enum verdicts, `--offline` for `.gmb` against pinned roots (SPEC §6). *(B)*
- **FR-10** `login`/`whoami`: OIDC identity for keyless Sigstore signing; no long-lived keys by default (SPEC §7). *(B)*
- **FR-11** `publish`: refuse-on-lint-fail, sign, upload to Publish API, poll review, print findings mapped to lint ids; `appeal` routes a second reviewer (SPEC §7). *(B)*
- **FR-12** `lint --registry`: capability diff vs last published ("will re-trigger review") + server-validated DAG pre-release (SPEC §5). *(B)*
- **FR-13** `bundle export|inspect` for signed `.gmb` (SPEC §2). *(B)*
- **FR-14** Publishes `@gridmason/cli` 0.x; installable `npm i -g` / `npx`; e2e: scaffold → lint → dev-serve (→ B: publish → verify against a local registry).

## Architecture & stack

Node + TS ESM binary. `src/commands`, `src/checks` (shared), `src/templates`, `src/publish` (B). Deps: `@gridmason/protocol`, `@gridmason/sdk` (fixture host + templates), Sigstore/OIDC client libs (B).

## Data model

Fixture schema owned by the SDK (sdk FR-4); lint report JSON schema defined here (FR-7).

## Screens & UX

Terminal UX + the dev-server SDK-inspector page (single self-contained page; simple table UI — no mockup needed, structure named in FR-6 issue).

## Epics & issues

### Epic: L-E0 Bootstrap
Goal: installable empty binary with CI + community files.
Depends on: protocol P-E1, sdk S-E1 on npm

- [ ] Repo scaffold: binary entry, command router, CI, changesets publish 0.0.x, community files
      FRs: FR-1, FR-14
      Acceptance: `npx @gridmason/cli --help` lists the command surface; CLA gate active

### Epic: L-E1 Scaffold + dev loop (Phase A)
Goal: `init` + `dev` — the author loop against the dashboard.
Depends on: L-E0

- [ ] `widget init`: prompts, manifest stub, publisher-prefix enforcement, props schema, story stub, CI workflow
      FRs: FR-2
      Acceptance: scaffolded project passes `gridmason lint` out of the box (all three templates)
- [ ] Templates: vanilla (bundler-free), React, Vue — each emitting an ES-module `entry` registering the element
      FRs: FR-2
      Acceptance: each template's entry loads in a bare HTML import-map harness and registers its tag
      Depends on: widget init
- [ ] Fixture seeding from manifest (`fixtures/` + context presets)
      FRs: FR-3
      Acceptance: fresh init + `dev` renders sample data with zero author edits
      Depends on: widget init
- [ ] `dev` server: serve entry, hot reload, manifest re-validation, fixture SDK mount, `--context`, `--proxy`
      FRs: FR-4, FR-5
      Acceptance: edit source → hot reload; fixture edit → data updates; proxy mode forwards with capability denial intact
      Depends on: Templates, Fixture seeding
- [ ] SDK inspector panel
      FRs: FR-6
      Acceptance: undeclared SDK call shows as violation; fixture-miss shows default-empty flag
      Depends on: dev server

### Epic: L-E2 Lint (Phase A)
Goal: the local review — same checks the registry will run.
Depends on: L-E0 (parallel with L-E1 after init lands)

- [ ] Shared checks module skeleton + manifest lint (schema, prefix, shapes)
      FRs: FR-7, FR-8
      Acceptance: protocol type vectors reused; checks importable as a library
- [ ] SDK-adherence static analysis (raw fetch/XHR, token reachability, obfuscation heuristics)
      FRs: FR-7
      Acceptance: seeded-violation fixture suite — each heuristic catches its planted sample, clean template passes
- [ ] Local `requires` DAG check + `--json` report + tier mapping
      FRs: FR-7
      Acceptance: cycle fixture fails with path printed; JSON validates against the report schema
- [ ] Lint e2e + docs: scaffold→lint green across templates; check-id reference page
      FRs: FR-7, FR-14
      Acceptance: e2e in CI; every check id documented with rationale + fix hint

### Epic: L-E3 Publish + verify (Phase B)
Goal: the trust path — sign, upload, verify.
Depends on: L-E2; protocol P-E3; registry R-E1

- [ ] `login`/`whoami` (OIDC, Sigstore keyless)
      FRs: FR-10
      Acceptance: identity round-trip against Sigstore staging; no key material written to disk
- [ ] `verify` command (online + `--offline` `.gmb`)
      FRs: FR-9
      Acceptance: protocol conformance vectors pass through the CLI surface; tampered artifact → correct enum verdict
- [ ] `publish`: lint-gate, sign, upload, poll, findings mapping; `appeal`
      FRs: FR-11
      Acceptance: e2e against a local registry instance publishes and reaches reviewed state
      Depends on: login, verify

### Epic: L-E4 Bundles + registry-aware lint (Phase B)
Goal: air-gap + pre-release CI checks.
Depends on: L-E3

- [ ] `bundle export|inspect`
      FRs: FR-13
      Acceptance: exported bundle verifies offline via `verify --offline`
- [ ] `lint --registry`: capability diff + server DAG validation
      FRs: FR-12
      Acceptance: capability-increase fixture reports re-review warning; server-side cycle caught pre-publish

## Milestones

1. **M-A:** L-E0–L-E2 — full author loop with the dashboard dev sideload.
2. **M-B:** L-E3–L-E4 — publish→verify e2e against a self-hosted registry.

## Risks & open questions

- Static-analysis depth for SDK adherence (FR-7): heuristics only in v0; document known-bypass honesty in the check reference.
- Hot-reload mechanics for a plain-ESM entry (cache-busting import URLs) — decide in L-E1 issue 4.

## Changelog

- 2026-07-13 — initial draft from the approved engineering spec set.
