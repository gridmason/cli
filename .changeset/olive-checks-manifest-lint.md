---
'@gridmason/cli': patch
---

Add the shared checks module (`@gridmason/cli/checks`) and implement manifest
lint for `gridmason lint` (FR-7, FR-8). The module is a plain library the
registry service imports verbatim — one implementation, no divergence (SPEC §8).
It ships three manifest checks — `manifest.schema` (authoritative
`@gridmason/protocol` JSON Schema), `manifest.tag` (publisher-prefix + tag rules
via `lintTag`), and `manifest.capabilities` (scope grammar via
`validateCapability`) — driven by the protocol's shipped conformance vectors.
`gridmason lint [path]` runs them with human and `--json` output and a
fail-closed exit code. See `docs/checks.md` for the check-id scheme.
