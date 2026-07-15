# `gridmason publish` / `gridmason appeal`

Sign a widget keyless and publish it to a Gridmason Registry (SPEC §7, §8;
FR-11). `publish` is the trust path: it runs the **same automated checks the
registry runs** locally first and **refuses to upload anything that would not
pass** (never upload known-bad), then binds a keyless Sigstore-style signature to
your `login` OIDC identity, uploads the immutable content-hashed artifact to the
target registry's Publish API, and polls the review outcome. `appeal` routes a
rejected submission to a second reviewer.

```bash
gridmason publish [path] --registry <url> [--token <jwt>] [--ambient] [--sigstore <instance>] [--json]
gridmason appeal  <artifact-id> --registry <url> [--token <jwt>] [--ambient] [--json]
```

`path` is the widget project directory (defaults to the current directory).
`--registry` is **required** — there is no baked-in default registry yet.

## The flow, gate by gate (fails closed at each)

1. **Assemble** the immutable, content-hashed artifact from the project: the
   `manifest.json`, its ES-module `entry`, and the widget's chunks + schemas +
   docs. Every part is addressed by the multihash-tagged SHA-256 of its exact
   bytes (`sha2-256:<hex>`), computed with `@gridmason/protocol` so the digests
   match the registry's own content addressing. The served set is a small, fixed
   convention (below), so no build junk is ever uploaded.
2. **Lint-gate** with the shared `src/checks` module — the *identical code* the
   registry's automated review runs (SPEC §8, "one implementation, no
   divergence"). If any check fails — a manifest-lint failure, a **cyclic
   `requires`**, or an **undeclared capability reach** — `publish` prints the
   failing findings and **refuses to upload** (SPEC §8). "Green locally" predicts
   "passes review" because it is the same code.
3. **Sign keyless.** A short-lived signature is bound to the OIDC identity
   `login` established; no long-lived key is written (SPEC §1, §8). The result is
   a DSSE-shaped signature envelope over the artifact subject.
4. **Upload** to `POST /v1/artifacts` with your OIDC token as the bearer. The
   registry content-addresses the parts, structurally validates the envelope,
   enforces `(tag, version)` immutability, and runs its automated review.
5. **Poll** the review status. On approval the registry countersigns, logs, and
   CDN-publishes the artifact. On rejection `publish` prints the reviewer's
   findings **mapped to the same `lint` check ids** (below) and exits non-zero.

`publish` exits `0` when the artifact is published or accepted-and-under-review,
and `1` on any refusal (lint gate, identity failure, upload error, rejection) or
malformed input.

## What gets uploaded (the served file set)

Deterministic and documented, so a scaffolded project publishes cleanly and
nothing else is shipped:

| Role | Files |
|---|---|
| `manifest` | `manifest.json` |
| `entry` | the file named by `manifest.entry` |
| `schema` | `manifest.props`, plus every `*.schema.json` at the project root or under `schemas/` |
| `chunk` | every `.js` / `.mjs` / `.cjs` under `src/` other than the entry (stories and tests excluded) |
| `doc` | `README.md` at the root, plus every `*.md` under `docs/` |

`node_modules`, `dist`/`build`, `.git`, `.github`, `fixtures/`, `package.json`,
and `*.stories.*` / `*.test.*` / `*.spec.*` files are never uploaded.

## Findings speak the `lint` vocabulary

Because the registry runs the shared checks module, a rejection's findings
reference the **same check ids** `gridmason lint` prints locally. `publish` looks
each one up in the shared registry and shows its title and the review tier it
feeds, so you fix a review failure with the identical check id you already know
(`sdk.raw-network`, `manifest.schema`, …). A reviewer's hand-made judgement uses
the `manual` sentinel and is shown as a manual-review finding.

## Identity and keyless signing

`publish` acquires an OIDC token exactly as [`login`](login-whoami.md) does — an
explicit `--token`, `GRIDMASON_OIDC_TOKEN`, or the ambient CI OIDC context
(`--ambient`); the interactive browser leg is not wired yet (#49). That token is
both the upload bearer and the identity the keyless signature is bound to.

The default signer is the **Sigstore public-good** instance (`--sigstore staging`
selects the staging CA): `@sigstore/sign` mints an ephemeral keypair in memory,
obtains a Fulcio short-lived certificate bound to your OIDC identity, and logs to
Rekor — nothing touches disk. This path needs network and an allowlisted-issuer
token, so it is exercised opt-in against a live instance (as `login`'s
live-staging leg is). The offline dev/e2e loop uses an ephemeral keyless signer
that produces the same DSSE shape without reaching Sigstore.

## `appeal`

`gridmason appeal <artifact-id> --registry <url>` routes a rejected submission to
a **second reviewer** (never the original — the reviewer≠author rule is the
registry's). The `<artifact-id>` is the id `publish` printed.

## Registry contract note (M-B1 gap)

The registry's M-B1 Publish API advances review state **synchronously in the
upload response** and exposes review findings only on a **reviewer-only** lane; it
does not yet ship a publisher-facing status/findings endpoint or an appeal
endpoint. `publish`/`appeal` are written against the forward contract they need —
`GET /v1/artifacts/:id` for status + findings and `POST /v1/artifacts/:id/appeal`
for a second review — and **fall back gracefully** to the upload response's state
when the status surface is absent. The end-to-end tests drive a **contract-
faithful fake Publish API server** (which runs the shared checks as its automated
review) in place of standing up the full registry service; see the test note.
