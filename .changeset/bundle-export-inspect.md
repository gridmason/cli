---
'@gridmason/cli': minor
---

Add `gridmason bundle export` / `gridmason bundle inspect` — produce and inspect
signed offline `.gmb` bundles (FR-13, SPEC §2; protocol §4.5, issue #18).

`bundle export` repackages an already-signed release (supplied via `--release` as a
local path or an `http(s)://` registry URL — the same `{ release, envelope,
trustRoot, logEntry }` document the online `verify` reads) plus the project's
servable bytes into a single self-sealing archive: it packs `entry` / `chunks` /
`schemas` / `docs`, seals the payload with an RFC-8785 content hash, and
self-verifies the written bundle through the offline chain (the full
`verify --offline` chain when pinned roots are supplied, else a pinless
archive-integrity + packed-byte gate). It signs nothing — the CLI mints no crypto;
the signature chain and transparency-log inclusion proof travel inside the bundle
from `publish`/the registry.

`bundle inspect` reads a `.gmb` through the same reader `verify --offline` uses
(size caps + traversal guards inherited) and prints the manifest identity, packed
file inventory, signing identity + countersignature, embedded inclusion proof, and
trust root, plus the offline verdict when pinned roots are available.

Reuses the `verify --offline` machinery verbatim (`resolveGmbBundle`,
`enforcePackedFiles`, `isSafeRelativePath`, `runVerifyOffline`) rather than
duplicating it. An exported bundle verifies offline via `verify --offline` against
the same pinned roots.
