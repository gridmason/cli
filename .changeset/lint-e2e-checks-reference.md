---
'@gridmason/cli': patch
---

Add a scaffold→lint end-to-end gate and complete the check-id reference (FR-7,
SPEC §5/§9).

- **E2e (`npm run test:e2e`, `vitest.e2e.config.ts`):** drives the *built* binary
  as a subprocess — `gridmason widget init` each starter template (vanilla /
  React / Vue, non-interactive flags) then `gridmason lint` the scaffold — and
  asserts a clean pass: exit 0, no failing check, and a `--json` report that
  validates against `schemas/lint-report.schema.json`. The binary is built once
  in the suite's `globalSetup`, so a regression in any check (or a template that
  drifts into tripping one) fails the gate. Wired into CI as a dedicated `e2e`
  job. This is the scaffold→lint leg of the SPEC §9 e2e; dev-serve/publish legs
  are Phase B.
- **`docs/checks.md` is now the complete author-facing check-id reference:** every
  id carries its rationale, registry review tier, severity, and the exact fix
  hint the tool prints, alongside the honest known-bypass notes for the heuristic
  `sdk.*` / `dom.*` checks. Linked from the README and a new `docs/` index.
