---
'@gridmason/cli': minor
---

Complete the `verify` command with the offline `.gmb` path (#16, second half):
`gridmason verify --offline <bundle.gmb>` verifies a self-contained bundle with
**no network** — the identical `verifyRelease` chain plus an archive-integrity
gate, delegated to `@gridmason/protocol@^0.2.0`'s `verifyOfflineBundle`. It reuses
the online path's seams (blind-root refusal via the shared trust-config loader,
SPEC §4.4; the shared verdict renderer), adds the two bundle-only reason classes
(`bundle-malformed`, `bundle-hash-tampered`) to the surfaced stable enum, and — on
a clean chain — enforces each packed file's bytes against the verified hash map
with `verifyChunk`, so a bundle that packs bytes not matching its signed hash is
caught at verify time. Bumps `@gridmason/protocol` to `^0.2.0` and adds
`docs/verify.md`. With this, issue #16 is fully implemented (online + offline).
