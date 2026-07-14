# `gridmason bundle export|inspect`

Produce and inspect a signed **offline `.gmb` bundle** (SPEC §2, FR-13; protocol
§4.5) — the air-gap artifact that carries everything a host fetches piecemeal
online, packed into one self-verifying document so a release can be verified and
loaded with **no network at all**.

```bash
gridmason bundle export [project]  --release <path|url>  [--output <path>] [--trust-config <path>] [--json]
gridmason bundle inspect <bundle.gmb>  [--trust-config <path>] [--json]
```

`bundle export` **signs nothing.** A `.gmb` is a *repackaging* of an
already-signed release: the CLI mints no certificates, countersigns nothing, and
issues no log-inclusion proof (those come from `login`/`publish` and the registry,
SPEC §7–§8). Export embeds the signed chain, packs the servable bytes, seals the
archive, and self-verifies it through the same offline chain `verify --offline`
runs.

## The `.gmb` layout (protocol §4.5)

A `.gmb` is a JSON document. Servable file bytes are base64 inside its `payload`;
the whole payload is sealed by a single content hash.

```
{
  formatVersion: "1.0",          // wire major the verifier speaks
  producedBy:    "registry…",    // provenance stamp — audit metadata, NOT a trust anchor
  contentHash:   "sha2-256:…",   // seals the canonical payload (RFC-8785); any change breaks it
  payload: {
    manifest,                    // the widget/plugin manifest (§3.1)
    release,                     // signed release doc: { artifact, files: { path → hash } }
    envelope,                    // dual-signature envelope; its logInclusion names logEntry
    logEntry,                    // transparency-log inclusion proof (embedded — checked offline)
    trustRoot,                   // the trust-root document the release anchors to
    entry,                       // the ES-module entry (manifest.entry), base64 bytes
    chunks: [ … ],               // remaining code modules
    schemas: [ … ],              // JSON Schema documents (e.g. the settings schema)
    docs:   [ … ]                // documentation / guide assets
  }
}
```

**Nothing is trusted for being in the bundle.** The embedded `trustRoot` is
believed only when it matches an operator **pin**; the signature/log chain is
checked in full. The producer cannot vouch for itself.

### File classification

The signed `release.files` map is authoritative for *which* files ship and their
hashes, but it does not tag their kind. Export derives the `payload` sections:

| Section | Rule |
|---|---|
| `entry` | the path equal to `manifest.entry` |
| `schemas` | the path equal to `manifest.props`, or any `*.schema.json` |
| `docs` | any `*.md` |
| `chunks` | everything else |

This split is the CLI's own convention. It affects only how `inspect` groups files
and the canonical byte order under the seal — **never verification**, which
addresses every file uniformly by path through the release map. A future
registry-authoritative categorization slots in without touching the verifier.

## `export` — assemble, seal, self-check

1. **Read the manifest** (`<project>/manifest.json`). Export does **not** re-run
   `lint`: it repackages an already registry-reviewed release, so the fail-closed
   gate is *byte-hash-match + self-verify*, not a second lint pass. The manifest is
   only required to be parseable and to declare a string `entry` (needed to
   classify the entry module).
2. **Load the signed release** from `--release` — a local path or an `http(s)://`
   registry URL. This is the same `{ release, envelope, trustRoot, logEntry }`
   document the online `verify` reads (no parallel format).
3. **Pack** every path in `release.files`, reading its bytes from the project
   (rejecting absolute / `..` paths), base64-encoding, and classifying it.
4. **Seal**: `contentHash = sha2-256(canonicalize(payload))`.
5. **Self-check** the freshly written bundle before reporting success:
   - **with `--trust-config`** (or `GRIDMASON_TRUST_CONFIG`): the **full** offline
     chain (`verify --offline`) against the pinned roots;
   - **without pins**: the **structural** gate only — re-derive the content hash
     (archive integrity) and re-check every packed file's bytes against the signed
     release hash (`verifyChunk`). This is the pre-publish gate that works with no
     registry.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | bundle written and self-verified (full chain green, or — pinless — archive+packed integrity ok) |
| `1` | refused (fail-closed): an unusable manifest, a released file missing/mismatched, an unsafe path, or a self-check refusal |
| `2` | inputs unusable (manifest/`--release`/output not readable/writable) |

## `inspect` — contents + verdict

Reads a `.gmb` through the **same** reader `verify --offline` uses (the size caps,
path guards, and malformed-shape handling in [`verify`](verify.md#gmb-structural-guard-untrusted-input)
all apply) and prints:

- the manifest identity (tag / kind / name / version) and `producedBy`;
- the packed **file inventory** grouped by section;
- the signing **identity** (publisher issuer + subject claims) and whether the
  release is registry-countersigned;
- the embedded **transparency-log inclusion proof** (log id, index, tree size);
- the **trust root** the release anchors to and its countersign roots;
- the offline **verdict** — rendered when pinned roots are supplied
  (`--trust-config` / `GRIDMASON_TRUST_CONFIG`), otherwise reported as
  `unverified` (an inspection is not a trust decision).

Exit `0` inspected (verified or unverified-by-choice) · `1` a trust refusal · `2`
the bundle is unreadable/malformed.

## Round trip

An exported bundle verifies through `verify --offline` against the same pinned
roots — the acceptance bar for FR-13:

```bash
gridmason bundle export ./my-widget --release ./release.json --output my-widget.gmb
gridmason verify --offline my-widget.gmb --trust-config ./trust.json --json
```

## Status — the signing gap

`export` needs a **signed** release (envelope + registry countersignature + log
inclusion proof). Those are produced by `gridmason publish` and the registry, which
land in later milestones (cli #17, registry #19). Until then the signed release is
supplied by hand (or fetched from a registry URL) via `--release`, and a *fully
green* `verify --offline` requires genuine registry signature material. Everything
export owns today — assembly, the content-hash seal, and packed-byte integrity — is
complete and self-checked; the trust-chain verdict goes green once real signatures
are available.
