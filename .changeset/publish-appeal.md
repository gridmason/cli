---
'@gridmason/cli': minor
---

Add `gridmason publish` and `gridmason appeal` (SPEC §7, §8; FR-11).

`publish` runs the shared `src/checks` locally and **refuses to upload** an
artifact that would fail review (a lint failure, a cyclic `requires`, or an
undeclared capability reach — never upload known-bad), then signs keyless
(Sigstore-style, bound to the `login` OIDC identity), uploads the immutable
content-hashed artifact (manifest + entry + chunks + schemas + docs) to the
target registry's Publish API, and polls review status. On rejection it prints the
reviewer's findings **mapped to the same `lint` check ids**; on approval the
registry countersigns and publishes. `appeal <artifact-id>` routes a rejected
submission to a second reviewer. See `docs/publish.md`.
