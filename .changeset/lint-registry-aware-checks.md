---
"@gridmason/cli": minor
---

Add registry-aware modes to `gridmason lint --registry <url>` (SPEC §5 checks 3–4, FR-12):

- **`capability.diff`** — diffs the manifest's declared capabilities against the last published version on the target registry; a capability increase warns "will re-trigger review" (registry §4, the 3-day capability re-review lane).
- **`deps.server-acyclic`** — submits the `requires` graph for validation against the registry's live transitive graph (registry §7), catching a cross-manifest cycle in CI rather than at publish.

Both plug into the shared `src/checks` module, the `--json` report, and the check-id/tier scheme (new `reReview` tier). They are fail-safe: an unreachable registry warns rather than passing falsely. A new `HttpRegistryClient` (and `RegistryClient` interface) is exported for the checks to read the registry through. Built against the cross-repo endpoint contract in gridmason/registry#31.
