---
'@gridmason/cli': patch
---

Add the local dependency-DAG check and the structured `gridmason lint --json`
report with check-id → review-tier mapping (FR-7, #13). `deps.acyclic` proves the
manifest's `requires` graph is acyclic offline — locally that catches a widget
requiring its own tag, printing the cycle path; transitive, cross-manifest cycles
stay the registry-validated `lint --registry` job (Phase B). `--json` now emits a
report that serializes every check result and maps each to the registry review
tier it feeds (registry §4.1–§4.2), with a `tiers` catalog resolving the SLAs, so
a CI consumer learns which review SLA an artifact will hit. The tier mapping is
data-driven by check-id `<group>` (`src/checks/tiers.ts`) — a new check family is a
one-line addition. The report shape is owned here and pinned by the shipped JSON
Schema `schemas/lint-report.schema.json`, which every emitted report validates
against. See `docs/checks.md`.
