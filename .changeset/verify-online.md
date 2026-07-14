---
'@gridmason/cli': minor
---

Add the `verify` command's online path (#16): `gridmason verify <artifact|url>`
resolves an artifact's release, envelope, trust-root document, and log entry, then
delegates the whole dual-signature + content-hash + transparency-log decision to
`@gridmason/protocol@^0.1.0`'s `verifyRelease` — the CLI holds no bespoke crypto.
Trust roots are pinned/config-supplied only (`--trust-config <path>` or
`GRIDMASON_TRUST_CONFIG`); with nothing pinned the command refuses to proceed
rather than trust a root fetched blind (SPEC §4.4). The library's stable verdict
enum is surfaced verbatim (never remapped); exit codes are `0` verified, `1`
refused, `2` no verdict reached. The `--offline` `.gmb` path stays deferred until
protocol P-E4 ships the bundle format, and reports not-yet-implemented.
