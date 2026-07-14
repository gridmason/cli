---
'@gridmason/cli': minor
---

Export the seeded-violation lint fixture suite as `@gridmason/cli/checks/fixtures`.

The planted-violation cases that drive the SDK-adherence and DOM-abuse checks
now ship in `dist` and are importable alongside `@gridmason/cli/checks`, so
consumers of the shared checks (the registry's automated review parity tests)
can assert against the canonical suite instead of a vendored copy (#43).
