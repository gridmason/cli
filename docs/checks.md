# `gridmason lint` — the shared review checks

`gridmason lint` runs the **same automated checks the registry runs** against a
widget project locally, so local-green predicts review-pass (SPEC §5, §8). The
checks live in one module — `src/checks`, published at `@gridmason/cli/checks` —
that the registry service imports **verbatim**: one implementation, no divergence
(FR-8). This page is the check-id reference. The manifest lint lands with #11;
SDK-adherence (#12), the dependency-DAG check, and the full `--json` tier mapping
(#13) extend it, each adding its ids to the table below.

```bash
gridmason lint [path] [--json] [--registry <url>]
```

`lint` reads `<path>/manifest.json` (default: the current directory), runs every
registered check, and reports:

- **human** diagnostics on **stderr** — one line per finding (`✓`/`!`/`✗`), a fix
  hint under each failure, and a summary;
- **`--json`** — a single report object on **stdout** and nothing else, for CI
  gating. (The report shape is minimal in #11; the check-id → review-tier mapping
  matures in #13.)

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

| id | group | what it checks | fails when |
|---|---|---|---|
| `manifest.schema` | manifest | The manifest is valid against the authoritative `@gridmason/protocol` manifest JSON Schema (protocol §3.1): required fields, the `formatVersion` / `version` patterns, the `kind` enum, the `size` / context / `capabilities` / `requires` **shapes**, and `additionalProperties: false`. | a required field is missing, a pattern/enum is violated, a nested shape is wrong, or an unknown property is present. |
| `manifest.tag` | manifest | The `tag` (the widget's custom-element name) is lowercase, contains a hyphen, uses only `[a-z0-9-]` starting with a letter, and is **prefixed with `<publisher>-`** — via the protocol's `lintTag`. | any tag rule is broken; the publisher-prefix rule is the one the JSON Schema cannot express, enforced here. |
| `manifest.capabilities` | manifest | Each declared capability's colon-delimited **scope grammar** is well-formed — via the protocol's `validateCapability`. | a scope segment is empty (e.g. `net:`, `records.read:a::b`). The api enum and the array shape are `manifest.schema`'s job, so an unknown api is reported there, not double-reported here. |
| `sdk.raw-network` | sdk | The widget's source performs no **raw network I/O outside the SDK** — no global `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, or `navigator.sendBeacon`. All egress must go through the capability-scoped SDK handle so the host can gate and audit it. | a raw network primitive is called outside the SDK (each hit is a `fail`, located `file:line:col`). This is the check most likely to fail a naive widget. |
| `sdk.token-reach` | sdk | The source does not reach **ambient credential/storage surfaces** the sandbox withholds — `document.cookie`, `localStorage`/`sessionStorage`, `indexedDB`, `window.name`. A widget receives scoped host data only through its handle. | `document.cookie` or Web Storage is read (`fail`); `indexedDB` / `window.name` are `warn` (ambient, sometimes benign). |
| `sdk.obfuscation` | sdk | The source contains no **indirection that hides** network/DOM access from static reading — `eval`/`Function`, `atob`/`String.fromCharCode`/`unescape` decode chains, computed/string-built access on a global object, dynamic `import()` of a computed specifier, string-argument `setTimeout`/`setInterval`. | dynamic code execution (`eval`, `new Function`) is a `fail`; the decoding/computed-access/string-timer heuristics are `warn`. |
| `dom.abuse` | dom | A frontend remote (registry §4.2, TF tier) keeps DOM access inside **its own subtree** — no document-wide queries, `document.body`/`head`/`documentElement`, document/window-level listeners or state (`title`/`write`), `window.open`, top-level navigation, or cross-frame reach (`top`/`parent`). | any document-/window-level reach, navigation, or cross-frame access is found. Every hit is a `warn` — surfaced for the TF-tier reviewer without failing the local gate on a heuristic alone. Element-scoped DOM (`document.createElement`, `element.addEventListener`, `customElements`) is **not** flagged. |

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
