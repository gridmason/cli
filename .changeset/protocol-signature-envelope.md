---
"@gridmason/cli": minor
---

`publish` now signs and uploads the `@gridmason/protocol` **`SignatureEnvelope`**
(publisher half) instead of a bare DSSE object (owner decision on gridmason/cli#70,
option a — the CLI emits the protocol envelope; the registry countersign contract
stays frozen). The upload `envelope` is
`{ formatVersion, subject{ artifact, releaseHash }, publisherSig{ alg, cert, issuer,
subjectClaims, sig } }`, where `releaseHash` is the SHA-256 multihash of the
canonical release document over the content-hash map — the exact document the
registry countersign reproduces and binds the signature to. Both the Sigstore leg
(Fulcio leaf + DER→P1363 signature) and the offline `ephemeralSigner` (a self-issued
keyless leaf in the profile the protocol verifier parses) emit this shape.

Adds `gridmason publish --signer <sigstore|ephemeral>`: `ephemeral` is an offline
keyless signer (no Sigstore network) for the dev / registry-e2e loop, so a registry
CI job can drive the real binary deterministically.

**Breaking wire-shape change against older registries.** A registry still expecting
the DSSE envelope will refuse this upload with `400 invalid_envelope`. Both sides
move together against this release: registry intake must accept the protocol
envelope, coordinated via **gridmason/registry#55**. Bumps the `@gridmason/protocol`
dependency to `^0.4.0` (the verify-lib line that owns the `SignatureEnvelope` wire
type + JCS canon + hashing).
