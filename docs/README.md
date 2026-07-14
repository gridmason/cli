# `@gridmason/cli` docs

Reference and guides for the `gridmason` binary — the widget-author devkit
(**scaffold → develop → lint → publish**). Start with the
[README](../README.md) for install and the command surface.

## Author guides

- [**`gridmason widget init`**](widget-init.md) — scaffold a widget / plugin /
  page-type / layout project.
- [**`init` templates**](templates.md) — what the vanilla, React, and Vue
  starters emit.
- [**Seeded `fixtures/`**](fixtures.md) — the sample contexts a scaffold ships
  with, used by `dev` and stories.
- [**`gridmason dev`**](dev-server.md) — the local dev server and author loop.

## Publish / identity

- [**`gridmason login` / `whoami`**](login-whoami.md) — establish and inspect the
  OIDC identity used for keyless Sigstore signing (no long-lived key on disk).

## Lint / review reference

- [**`gridmason lint` — the check-id reference**](checks.md) — every check id a
  scaffold or `lint` run can surface: what it means, the registry review tier it
  feeds, how to fix it, and the known bypasses of the heuristic `sdk.*` / `dom.*`
  checks.

## Engineering

- [Engineering spec (`SPEC.md`)](SPEC.md) — the authoritative design.
- [Build plan (`specs/cli-v0/spec.md`)](specs/cli-v0/spec.md) — the v0 milestones
  and functional requirements.
