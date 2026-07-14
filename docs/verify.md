# `gridmason verify`

Local trust check (SPEC §6, FR-9): given an artifact plus **pinned** trust roots,
run the identical **dual signature + content hash + transparency-log inclusion**
chain a host runs before it loads a release, and print a stable-enum verdict. This
is what makes "the reviewed hash is the runnable artifact" auditable by anyone, not
just the registry.

```bash
gridmason verify <artifact|url>  --trust-config <path> [--json]
gridmason verify --offline <bundle.gmb>  --trust-config <path> [--json]
```

The CLI holds **no bespoke crypto**. Every decision is delegated to the
`@gridmason/protocol` verify library — `verifyRelease` online, `verifyOfflineBundle`
for `.gmb` — so the CLI and a host meet on one pinned verification core.

## Two paths, one chain

| | Source | Delegates to | Network |
|---|---|---|---|
| **online** | an `http(s)://` URL, or a local verification-input JSON file carrying `{ release, envelope, trustRoot, logEntry }` | `verifyRelease` | fetches the artifact inputs |
| **`--offline`** | a self-contained `.gmb` bundle (a JSON document; servable file bytes are base64 inside its `payload`) | `verifyOfflineBundle` | **none** — every input is sourced from the bundle |

The offline path runs the *same* chain with one archive-integrity gate in front
(the bundle-level content hash seals the whole payload), then — on a clean chain —
re-checks each packed file's bytes against the verified hash map with `verifyChunk`,
so a bundle that packs bytes not matching its signed hash is caught here rather than
only at load time.

## Trust roots are pinned — never fetched blind

`verify` never trusts a root supplied over the network without a pin (protocol
§4.4, SPEC §8), exactly matching host rules. Trust material is **only** ever
config-supplied, from one of:

1. `--trust-config <path>`
2. the `GRIDMASON_TRUST_CONFIG` environment variable (a file path)

With no config — or a config that pins nothing — `verify` **refuses to proceed**
before any network or bundle work, exiting `2` with `no-trust-config`. The
network-delivered / embedded trust-root *document* is still untrusted input: it is
believed only when one of its countersign roots matches an operator pin.

### Trust-config file

A JSON document. Binary keys are base64-encoded (decoded to bytes internally):

```json
{
  "pins": [
    { "registryId": "registry.gridmason.dev", "root": "<countersign-root-id>", "channel": "deploy-time" }
  ],
  "publisherCARoots": ["<base64 SPKI DER>"],
  "countersignRoots": ["<base64 SPKI DER>"],
  "logPublicKey": { "name": "<checkpoint-signer>", "key": "<base64 32-byte Ed25519>" }
}
```

- **`pins`** (required, ≥1) — the operator's out-of-band declaration that `root`
  is a trusted countersign root for `registryId`. `channel` is `build-time` or
  `deploy-time` (advisory; does not change the decision). This is the blind-root
  gate: a trust-root document whose countersign roots no pin covers is refused.
- **`publisherCARoots` / `countersignRoots`** (optional, default `[]`) — pinned
  root public keys (SPKI DER) the publisher-cert and registry-countersign chains
  are checked against.
- **`logPublicKey`** (required) — the pinned transparency-log checkpoint key the
  inclusion proof is verified against.

## Verdicts

On success (`--json`): `{ "command": "verify", "status": "verified", "artifact",
"issuer", "subject", "fileCount" }`. On refusal: `{ "status": "refused", "reason"
}`, where `reason` is one **stable** enum value, surfaced verbatim from the
protocol and never carrying an input-derived identifier (the no-tag-echo rule,
SPEC §7).

The online reason set (`VERIFY_RELEASE_REASONS`):

`trust-root-malformed` · `trust-root-untrusted` · `trust-root-expired` ·
`trust-root-rotation-invalid` · `release-malformed` · `content-hash-mismatch` ·
`unsupported-format` · `publisher-signature-invalid` · `publisher-untrusted` ·
`publisher-identity-invalid` · `issuer-not-allowlisted` ·
`registry-countersignature-missing` · `registry-countersignature-invalid` ·
`log-inclusion-mismatch` · `log-inclusion-invalid` · `log-forked`

The offline path adds two bundle-only archive-integrity classes
(`VERIFY_BUNDLE_REASONS` is the online set plus these):

- `bundle-malformed` — the bundle-level content hash is not a well-formed
  `sha2-256:<hex>` string, or the payload could not be canonicalized.
- `bundle-hash-tampered` — the payload canonicalizes and the declared hash is
  well-formed, but they disagree: the archive was altered after it was sealed.

A packed-byte enforcement failure (a `.gmb` whose packed bytes do not match the
verified hash map) is reported as `content-hash-mismatch`.

## Exit codes

A stable three-way contract for CI:

| Code | Meaning |
|---|---|
| `0` | verified |
| `1` | refused — the chain reached a trust/crypto verdict (artifact present and well-formed, did not pass) |
| `2` | no verdict reached — blind/invalid trust config, or an unreadable/malformed artifact or bundle |

Human diagnostics go to stderr; `--json` prints the machine verdict to stdout.
