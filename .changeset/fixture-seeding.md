---
"@gridmason/cli": patch
---

Seed `fixtures/` from the manifest on `widget init` (FR-3). `seedFixtures` derives
a `FixtureFile` (shape owned by `@gridmason/sdk/fixture`) mechanically from the
generated manifest: a `records.read` template + `records.query` list per
`requiresContext` recordType, an empty `net` stub per `net:<host>` capability, a
scripted emission per `events:<ns>` capability, and a default + named `contexts/`
page-context preset — so the first `gridmason dev` renders with data before the
author edits anything. Bumps `@gridmason/sdk` to `^0.2.0` (the version that ships
the fixture schema) and, with it, the scaffold's declared `records.read` scope to
the SDK's `recordType:<type>` grammar (`records.read:recordType:example`) so the
scaffold's own reads pass capability enforcement — fixture-green predicts
review-green.
