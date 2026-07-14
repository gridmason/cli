---
"@gridmason/cli": patch
---

Implement `gridmason widget init`: scaffold a widget/plugin/page-type/layout
project (SPEC §3, FR-2). Prompts for (or reads as flags) the name, publisher
prefix, kind, and framework, then writes a publisher-prefixed manifest stub —
with the prefix rule enforced at creation via the protocol's `lintTag` — plus the
framework `entry`, a draft-07 props schema, a thumbnail placeholder, a Storybook
story stub, a CI workflow that runs `gridmason lint`, a `package.json`/README, and
a seeded `fixtures/` directory. Template bodies (`src/templates`) and fixture
seeding (`src/init/fixtures.ts`) are wired as extension seams for the follow-on
issues. Command actions can now signal a non-zero exit code via `ExitCodeError`.
