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
