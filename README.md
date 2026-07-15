# `@gridmason/cli`

The **`gridmason`** binary: the widget-author devkit and the publish path into a
[Gridmason](https://github.com/gridmason) Registry. One binary spans the whole
author loop — **scaffold → develop → lint → publish** — and runs the *identical*
automated checks a registry review runs, locally, so "green locally" predicts
"passes review."

Engineering spec: [`docs/SPEC.md`](docs/SPEC.md) · Build plan:
[`docs/specs/cli-v0/spec.md`](docs/specs/cli-v0/spec.md).

> **Status: 0.x.** The full author loop is implemented and documented —
> `widget init`, `dev`, `lint`, `verify`, `publish`, `appeal`, `bundle`, `login`,
> and `whoami` all do real work (see [`docs/`](docs/README.md) and each command's
> `--help`). Being pre-1.0, the surface may still change across the cli-v0
> milestones (SPEC §10); track what is landing in the repo's issues. Publishing to
> a live registry additionally depends on a running Gridmason Registry (see
> [Getting started](#getting-started-your-first-widget)).

## Install

```bash
npm i -g @gridmason/cli   # global install; provides the `gridmason` binary
# or run without installing:
npx @gridmason/cli --help
```

Requires **Node.js >= 22**.

## Command surface

```
gridmason widget init [name]        scaffold a widget/plugin/page-type/layout project
gridmason dev                       local dev server; serves the remote for the dashboard `dev` sideload
gridmason lint                      run the exact automated registry review checks locally
gridmason verify <artifact>         verify signature chain + content hash + log inclusion (offline-capable)
gridmason publish                   sign (keyless) + upload + poll review status
gridmason appeal <artifact>         request a second reviewer for a rejected artifact
gridmason bundle export|inspect     produce/inspect a signed offline .gmb bundle
gridmason login | whoami            OIDC identity used for keyless signing
```

`widget` is the noun namespace (it mirrors the manifest `kind`:
`widget`/`plugin`/`page-type`/`layout`). Global flags, accepted after the command
name: `--registry <url>` (defaults to config, then the flagship registry),
`--json` (machine output for CI), `--offline` (verify/bundle without network).

Run `gridmason <command> --help` for the details of any command.

## Getting started: your first widget

The author loop is **scaffold → develop → lint → publish**. Each step below has a
fuller guide under [`docs/`](docs/README.md).

1. **Scaffold a project.** Pick a human name and your publisher prefix (the tag
   becomes `<publisher>-<slug>`); `--kind` and `--framework` default to `widget`
   and `vanilla`.

   ```bash
   gridmason widget init "Sales Chart" --publisher acme
   cd sales-chart
   ```

   The scaffold is lint-clean out of the box. See
   [`docs/widget-init.md`](docs/widget-init.md).

2. **Develop against the local harness.** Serve the widget for the dashboard
   `dev` sideload and iterate:

   ```bash
   gridmason dev            # harness at http://127.0.0.1:3000
   ```

   See [`docs/dev-server.md`](docs/dev-server.md).

3. **Lint** — run the *exact* automated checks a registry review runs, so "green
   locally" predicts "passes review":

   ```bash
   gridmason lint           # add --json for CI, --registry <url> for the two networked checks
   ```

   Every check id is documented in [`docs/checks.md`](docs/checks.md).

4. **Establish an identity, then publish.** `publish` signs keyless against the
   identity `login` establishes, then uploads and polls the review outcome:

   ```bash
   gridmason login                          # interactive browser sign-in (or --token / --ambient in CI)
   gridmason publish --registry <url>       # e.g. https://registry.example.com
   ```

   `--registry <url>` is **required** — there is no baked-in default registry yet,
   so point it at a running Gridmason Registry. You can self-host one from
   [github.com/gridmason/registry](https://github.com/gridmason/registry). If a
   submission is rejected, `gridmason appeal <artifact-id> --registry <url>`
   routes it to a second reviewer. See [`docs/publish.md`](docs/publish.md).

## Documentation

Full guides and reference live in [`docs/`](docs/README.md):

- [**`gridmason widget init`**](docs/widget-init.md) and the
  [**`init` templates**](docs/templates.md) — scaffold a project.
- [**`gridmason dev`**](docs/dev-server.md) — the local author loop.
- [**`gridmason lint` — the check-id reference**](docs/checks.md) — every check
  id `lint` (and the registry) can raise: what it means, the review tier it
  feeds, and how to fix it.

## Development

```bash
git clone https://github.com/gridmason/cli.git
cd cli
npm ci
```

Local checks — exactly what CI runs; all four must be green before you open a PR:

```bash
npm run build       # tsc -> dist/ (ESM + type declarations, incl. the bin)
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run lint        # eslint
```

## License & contributing

`@gridmason/cli` is licensed under **[AGPL-3.0](LICENSE)**. Sniper7Kills LLC also
offers Gridmason under separate commercial terms; to keep that dual licensing
possible, **every contributor must sign the
[Contributor License Agreement](.github/CLA.md)** before their pull request can
be merged (a bot guides you on your first PR). See
[`CONTRIBUTING.md`](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md). Report suspected vulnerabilities per the
[Security Policy](SECURITY.md) — never in a public issue.
