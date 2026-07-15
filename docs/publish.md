# `gridmason publish` / `gridmason appeal`

Sign a widget keyless and publish it to a Gridmason Registry (SPEC §7, §8;
FR-11). `publish` is the trust path: it runs the **same automated checks the
registry runs** locally first and **refuses to upload anything that would not
pass** (never upload known-bad), then binds a keyless Sigstore-style signature to
your `login` OIDC identity, uploads the immutable content-hashed artifact to the
target registry's Publish API, and polls the review outcome. `appeal` routes a
rejected submission to a second reviewer.

```bash
gridmason publish [path] --registry <url> [--token <jwt>] [--ambient] [--sigstore <instance>] [--signer <kind>] [--json]
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
   the **publisher half of the `@gridmason/protocol` `SignatureEnvelope`** —
   `{ formatVersion, subject{ artifact, releaseHash }, publisherSig{ alg, cert,
   issuer, subjectClaims, sig } }` — over the canonical release subject (below).
   The registry applies the countersignature half and a host verifies both.
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
explicit `--token`, `GRIDMASON_OIDC_TOKEN`, the ambient CI OIDC context
(`--ambient`), or, in an interactive terminal, the browser sign-in flow (an
authorization code with PKCE over a loopback redirect). That token is both the
upload bearer and the identity the keyless signature is bound to.

The default signer is the **Sigstore public-good** instance (`--sigstore staging`
selects the staging CA): `@sigstore/sign` mints an ephemeral keypair in memory and
obtains a Fulcio short-lived certificate bound to your OIDC identity — nothing
touches disk. `publish` carries that leaf certificate and the signature over the
canonical subject in `publisherSig`; transparency-log anchoring is the registry's
job at countersign, not the publisher's. This path needs network and an
allowlisted-issuer token, so it is exercised opt-in against a live instance (as
`login`'s live-staging leg is).

### `--signer ephemeral` (offline dev / e2e)

`--signer ephemeral` selects an **offline** keyless signer that reaches no
network: it mints a per-invocation in-memory ECDSA P-256 keypair, signs the
subject, and **self-issues** a leaf certificate in the same profile
`@gridmason/protocol` verifies (the OIDC issuer in the Fulcio issuer extension, the
identity email in the SAN), then discards the key. A host pins that leaf's own
public key as the publisher root. It still needs an identity (`--token` /
`--ambient`) for the issuer + subject claims it mirrors into the envelope, but no
Sigstore.

It is a **dev / e2e affordance, not a Fulcio identity** — its cert chains to
nothing a production host pins, so a conforming host that pins real Fulcio roots
refuses it. Its purpose is to let a registry (or a local instance) drive the real
`gridmason publish` binary deterministically without Sigstore network — e.g.
`gridmason publish --registry <url> --token <jwt> --signer ephemeral`.

### The canonical release subject

`releaseHash` is the SHA-256 multihash (`sha2-256:<hex>`) of the canonical
(RFC-8785 / JCS) **release document** `{ formatVersion: "1.0", artifact, files }`,
where `files` is the `{ served path → content hash }` map of everything uploaded.
The registry countersign reproduces this document byte-for-byte and refuses to
countersign a signature whose `releaseHash` does not bind the uploaded content, so
the signature commits to the exact served bytes.

## `appeal`

`gridmason appeal <artifact-id> --registry <url>` routes a rejected submission to
a **second reviewer** (never the original — the reviewer≠author rule is the
registry's). The `<artifact-id>` is the id `publish` printed.

## Registry contract note

`publish`/`appeal` poll the registry's publisher-facing review surface:
`GET /v1/artifacts/:id/status` for state + findings and
`POST /v1/artifacts/:id/appeal` for a second review. The status path carries a
`/status` suffix because the bare `GET /v1/artifacts/:id` template is the
registry's frozen, hash-addressed artifact-serving origin; the two GET handlers
cannot share one path template. The response shapes are unchanged. `publish` also
**falls back gracefully** to the upload response's state when the status surface
is absent. The end-to-end tests drive a **contract-faithful fake Publish API
server** (which runs the shared checks as its automated review) in place of
standing up the full registry service; see the test note.
