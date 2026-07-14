---
"@gridmason/cli": patch
---

Add the `gridmason dev` **SDK inspector** (SPEC §4, FR-6): a standalone panel at
`/@dev/inspector` (linked from the harness dev bar) that shows the capabilities
the manifest declared against the gated SDK calls the widget actually made — so an
author sees an **undeclared reach** (flagged as a violation, exactly what review
would deny) and an **uncovered data path** (`default-empty` — allowed but no
fixture matched) before publishing. The SDK fixture implementation already tags
each gated call `fixture-hit` / `default-empty` / `denied` / `allowed`; the harness
reports that tag to `POST /@dev/inspect`, the server enriches it with the required
capability and whether the live manifest declares it (reusing the `--proxy`
capability grammar), and broadcasts it to the panel over the existing SSE channel.
`--proxy` mounts are recorded server-side from the same enforcement path. The
panel changes no runtime behavior and serves no data — a pure author-feedback lens
that resets each re-mount. Documented in `docs/dev-server.md`.
