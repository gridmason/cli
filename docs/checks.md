# `gridmason lint` — the shared review checks

`gridmason lint` runs the **same automated checks the registry runs** against a
widget project locally, so local-green predicts review-pass (SPEC §5, §8). The
checks live in one module — `src/checks`, published at `@gridmason/cli/checks` —
that the registry service imports **verbatim**: one implementation, no divergence
(FR-8). This page is the **complete check-id reference**: for every id a widget
author can hit, it says what the check means, which registry review tier it
feeds, and how to fix a finding — plus the honest bypass notes for the heuristic
`sdk.*` / `dom.*` checks. Jump to a specific id from the [table below](#checks).

```bash
gridmason lint [path] [--json] [--registry <url>]
```

`lint` reads `<path>/manifest.json` (default: the current directory), runs every
registered check, and reports:

- **human** diagnostics on **stderr** — one line per finding (`✓`/`!`/`✗`), a fix
  hint under each failure, and a summary;
- **`--json`** — a single report object on **stdout** and nothing else, for CI
  gating. It serializes every check result and maps each to its registry review
  tier (see [The `--json` report](#the---json-report-and-review-tiers) below).

The process **exit code is `0` if and only if no check failed** (a `warn` does not
fail the run), so `publish` and CI fail closed. A missing or non-JSON
`manifest.json` is itself an exit-1 error (`code: no-manifest` / `invalid-json`).

## The check-id scheme

Every check has a **stable, dotted id**: `<group>.<slug>`.

- `<group>` names the check family from SPEC §5, and is what a review tier is
  mapped from (#13): `manifest`, `sdk`, `deps`, `dom`.
- `<slug>` names the specific rule within the group.

Ids are a **public contract**: they are echoed by every result the check emits and
by the registry's review findings, so a local `✗ manifest.tag` and a server-side
finding line up exactly. **An id is never renamed once shipped** — a rule that
changes meaning gets a new id and the old one is retired.

A check emits a single `pass` result when clean, or one or more `warn`/`fail`
results when not — so a run enumerates every check that ran, not only the
failures. A check whose subject is **absent or malformed at a level another check
owns** stays silent and defers (e.g. `manifest.tag` emits nothing when `tag` is
not a string — that is `manifest.schema`'s failure to report).

## Checks

The table indexes every id; the reference entries below give each one's
rationale, the review tier it feeds, its severity, and the **fix hint** the tool
prints under a failure. The `sdk.*` / `dom.*` entries are heuristics — read
[their known bypasses](#static-analysis-is-heuristics-only--its-known-bypasses)
before trusting a clean run.

| id | group | tier | severity | one-line |
|---|---|---|---|---|
| [`manifest.schema`](#manifestschema) | manifest | automated | fail | manifest conforms to the protocol JSON Schema |
| [`manifest.tag`](#manifesttag) | manifest | automated | fail | the `tag` is well-formed and publisher-prefixed |
| [`manifest.capabilities`](#manifestcapabilities) | manifest | automated | fail | each capability scope grammar is well-formed |
| [`sdk.raw-network`](#sdkraw-network) | sdk | TF | fail | no raw network I/O outside the SDK |
| [`sdk.token-reach`](#sdktoken-reach) | sdk | TF | fail / warn | no reach to ambient credential/storage surfaces |
| [`sdk.obfuscation`](#sdkobfuscation) | sdk | TF | fail / warn | no indirection that hides network/DOM access |
| [`deps.acyclic`](#depsacyclic) | deps | automated | fail | the `requires` graph is acyclic |
| [`dom.abuse`](#domabuse) | dom | TF | warn | a frontend remote stays inside its own subtree |

Tier ⇒ review SLA is resolved in [Review tiers](#review-tiers): `automated` runs
synchronously at publish; `TF` is the 5-day frontend-remote human review.

### `manifest.schema`

- **Group / tier / severity:** manifest · automated · **fail**.
- **Checks:** the manifest is valid against the authoritative
  `@gridmason/protocol` manifest JSON Schema (protocol §3.1): required fields, the
  `formatVersion` / `version` patterns, the `kind` enum, the `size` / context /
  `capabilities` / `requires` **shapes**, and `additionalProperties: false`.
- **Fails when:** a required field is missing, a pattern/enum is violated, a
  nested shape is wrong, or an unknown property is present.
- **Fix:** align `manifest.json` with the manifest schema (protocol §3.1) — the
  failure line names the offending JSON path.

### `manifest.tag`

- **Group / tier / severity:** manifest · automated · **fail**.
- **Checks:** the `tag` (the widget's custom-element name) is lowercase, contains
  a hyphen, uses only `[a-z0-9-]` starting with a letter, and is **prefixed with
  `<publisher>-`** — via the protocol's `lintTag`. The publisher-prefix relation
  is the one rule the JSON Schema cannot express, so it is enforced here.
- **Fails when:** any tag rule is broken. Defers (emits nothing) when `tag` is not
  a string — that is `manifest.schema`'s failure to report.
- **Fix:** prefix the tag with `"<publisher>-"` so it matches the manifest
  `publisher`; keep it lowercase, hyphenated, and `[a-z0-9-]` starting with a
  letter. The hint is tailored to the specific violation the protocol reports.

### `manifest.capabilities`

- **Group / tier / severity:** manifest · automated · **fail**.
- **Checks:** each declared capability's colon-delimited **scope grammar** is
  well-formed — via the protocol's `validateCapability`.
- **Fails when:** a scope segment is empty (e.g. `net:`, `records.read:a::b`). The
  api enum and the array shape are `manifest.schema`'s job, so an unknown api is
  reported there, not double-reported here.
- **Fix:** give every colon-delimited scope segment a non-empty value.

### `sdk.raw-network`

- **Group / tier / severity:** sdk · TF · **fail** (each hit, located
  `file:line:col`). This is the check most likely to fail a naive widget —
  surfacing it locally is the point.
- **Checks:** the widget's source performs no **raw network I/O outside the
  SDK** — no global `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, or
  `navigator.sendBeacon`. All egress must go through the capability-scoped SDK
  handle so the host can gate and audit it.
- **Fails when:** a raw network primitive is called outside the SDK.
- **Fix:** do network I/O through the capability-scoped SDK handle (declare a
  `net:<host>` capability); the registry rejects raw network access outside the
  SDK.

### `sdk.token-reach`

- **Group / tier / severity:** sdk · TF · **fail** for `document.cookie` and Web
  Storage; **warn** for `indexedDB` / `window.name` (ambient, sometimes benign).
- **Checks:** the source does not reach **ambient credential/storage surfaces**
  the sandbox withholds — `document.cookie`, `localStorage` / `sessionStorage`,
  `indexedDB`, `window.name`. A widget receives scoped host data only through its
  handle.
- **Fails when:** `document.cookie` or Web Storage is read.
- **Fix:** a widget receives host data only through its SDK handle; reading
  ambient browser credential/storage surfaces (cookies, Web Storage, `indexedDB`)
  is outside the sandbox and fails review.

### `sdk.obfuscation`

- **Group / tier / severity:** sdk · TF · **fail** for dynamic code execution
  (`eval`, `new Function`); **warn** for the decode-chain / computed-access /
  string-timer heuristics.
- **Checks:** the source contains no **indirection that hides** network/DOM access
  from static reading — `eval` / `Function`, `atob` / `String.fromCharCode` /
  `unescape` decode chains, computed/string-built access on a global object,
  dynamic `import()` of a computed specifier, string-argument `setTimeout` /
  `setInterval`.
- **Fails when:** dynamic code execution is found; the other patterns warn.
- **Fix:** remove the dynamic-code / decoding indirection so the checks (and a
  human reviewer) can read what the widget does; obfuscation that hides network
  or DOM access is a review rejection.

### `deps.acyclic`

- **Group / tier / severity:** deps · automated · **fail**.
- **Checks:** the manifest's `requires` graph (`{ tag, range }` dependency-DAG
  edges, protocol §3.1) is **acyclic**. Local/offline, so it sees one manifest:
  the only cycle it can prove is a widget that requires its **own tag**.
  Transitive, cross-manifest cycles are the registry-validated `lint --registry`
  job (Phase B, #19). On failure the message prints the cycle path
  (`acme-chart → acme-chart`).
- **Fails when:** a required tag closes a cycle back to the widget's own tag.
  Absent/non-array `requires` and a non-string `tag` defer (those are
  `manifest.schema` / `manifest.tag`'s to report); malformed requirement entries
  are skipped, not double-reported.
- **Fix:** break the cycle — a widget must not (transitively) require itself.

### `dom.abuse`

- **Group / tier / severity:** dom · TF · **warn** (every hit). Advisory: it
  surfaces a reach for the TF-tier reviewer without failing the local gate on a
  heuristic alone.
- **Checks:** a frontend remote (registry §4.2, TF tier) keeps DOM access inside
  **its own subtree** — no document-wide queries, `document.body` / `head` /
  `documentElement`, document/window-level listeners or state (`title` / `write`),
  `window.open`, top-level navigation, or cross-frame reach (`top` / `parent`).
  Element-scoped DOM (`document.createElement`, `element.addEventListener`,
  `customElements`) is **not** flagged.
- **Fails when:** never fails the gate — every document-/window-level reach,
  navigation, or cross-frame access is a `warn`.
- **Fix:** keep DOM access inside the widget's own element/shadow subtree;
  document- or window-level reach, top navigation, and cross-frame access are
  reviewed under the frontend (TF) tier.

### Why the manifest lint is three checks, not one

SPEC §5.1 lists manifest lint as one item ("schema-valid, publisher-prefix, shapes,
`requires` well-formed"), but it splits into three ids because the rules come from
three protocol primitives and a reviewer wants to know **which** failed:

1. the **JSON Schema** covers every structural shape (including `size`, context,
   `capabilities`, and `requires` well-formedness) in one authoritative validator;
2. `lintTag` adds the **publisher-prefix** relation a schema cannot express;
3. `validateCapability` adds the **scope grammar** a "scope is a string" schema
   cannot express.

All three are `@gridmason/protocol`'s own code — no shape is re-declared in the
CLI — which is what keeps `lint` and registry review from drifting (SPEC §8), and
is verified by driving the protocol's shipped conformance vectors (protocol §6)
through these checks in the test suite.

## Static analysis is heuristics-only — its known bypasses

The `sdk.*` and `dom.*` checks read the widget's own source (`gridmason lint`
collects the `src/` tree plus the manifest `entry`; the registry analyses the
uploaded artifact) and match a set of regex rules against a **masked** view of it —
comments and string/template-literal *contents* are blanked first, so a keyword in
a comment or a string is never mistaken for a call. This keeps false positives off
the clean `gridmason init` templates (verified in the test suite) at the cost of
**completeness**: the rules catch the honest mistake and the lazy evasion, not a
determined one. Per the spec's Risks note, v0 does not claim static analysis is
complete. Every rule's bypasses are documented so the guarantee is not overstated:

- **Aliasing / indirection** — a primitive captured in a variable and called
  later (`const f = fetch; f(u)`, `const d = document; d.body`) is not traced;
  only the direct reach is matched.
- **Reflection / runtime assembly** — a name built at runtime and reached
  reflectively evades the string rules; `sdk.obfuscation` flags the *presence* of
  such indirection (computed global access, `eval`, decode chains) rather than
  proving what it resolves to.
- **Masked regions** — code hidden inside a template-literal `${…}` interpolation
  is not analysed (the interpolation is blanked with the rest of the literal), and
  a regex literal whose body contains a quote can mis-mask the code after it.
- **Scope of files** — only the `src/` tree and the manifest `entry` are read
  locally; source imported from elsewhere in the project is out of scope for the
  CLI (the registry closes this by analysing the built artifact).
- **`dom.abuse` is advisory** — every finding is a `warn`: it surfaces a reach for
  the TF-tier reviewer, it does not gate the local build, because a heuristic
  alone should not fail an author on a DOM pattern.

Because they are heuristics, a hit is a prompt to look, not a proof of intent; a
clean run is evidence, not a guarantee. The registry's review is the authority —
`lint` exists to make its likely verdict visible early.

## The `--json` report and review tiers

`gridmason lint --json` prints a single report object on stdout. Its shape is a
contract this repo owns (cli-v0 spec, Data model), pinned by the JSON Schema at
[`schemas/lint-report.schema.json`](../schemas/lint-report.schema.json) and
shipped in the npm package — a CI consumer can validate against it directly. Every
object the command emits validates against that schema (checked in the test suite).

A run report serializes **every** check result and tags each with the **registry
review tier** its findings feed, so a CI consumer learns which review SLA the
artifact will hit before it publishes (SPEC §5, FR-7):

```jsonc
{
  "command": "lint",
  "status": "pass",                       // "fail" iff any check failed; mirrors the exit code
  "results": [
    { "id": "manifest.schema", "status": "pass", "message": "…", "tier": "automated" },
    { "id": "deps.acyclic",    "status": "pass", "message": "…", "tier": "automated" }
  ],
  "tiers": {                              // catalog resolving each result's `tier` id to its SLA
    "automated": { "id": "automated", "title": "automated review", "reference": "registry §4.1" }
  }
}
```

When the manifest cannot be loaded, the **error** variant is emitted instead
(`status: "error"`, a `code` of `no-manifest` / `invalid-json`, and a `message`) —
also covered by the schema.

### Review tiers

Each check id maps to a registry review tier (registry §4.1–§4.2) by its `<group>`
prefix. The mapping is data-driven (`src/checks/tiers.ts`), so a new check family
maps with a one-line addition:

| group | tier | tier meaning | flagship SLA |
|---|---|---|---|
| `manifest` | `automated` | the automated review stage every publish runs (registry §4.1) | synchronous at publish |
| `deps` | `automated` | same automated stage — the dependency-DAG check (registry §4.1) | synchronous at publish |
| `sdk` | `TF` | frontend-remote human review: SDK-adherence static analysis (registry §4.2) | 5d |
| `dom` | `TF` | frontend-remote human review: DOM-abuse heuristics (registry §4.2) | 5d |

The `T1` tier (declarative artifacts, no executable content — SLA 2d) exists in the
registry's review model and is carried in the report's tier catalog for
completeness, though no v0 check family targets it. An unmapped group falls back to
`automated`, the floor every publish hits.

## Consuming the checks as a library (the registry path)

The registry service imports the module directly, without the CLI:

```ts
import { checks, runChecks, hasFailure, type CheckContext } from '@gridmason/cli/checks';

const ctx: CheckContext = { manifest /* parsed manifest.json, untrusted */ };
const results = runChecks(ctx);         // flat CheckResult[] in check order
const rejected = hasFailure(results);   // true if any result is `fail`
```

`CheckContext` is **additive**: a later check that needs more input (e.g. #12's
source files) adds an optional field; existing checks ignore what they do not
read, so the surface never breaks a consumer.
