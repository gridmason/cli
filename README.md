# `@gridmason/cli`

The **`gridmason`** binary: the widget-author devkit and the publish path into a
[Gridmason](https://github.com/gridmason) Registry. One binary spans the whole
author loop — **scaffold → develop → lint → publish** — and runs the *identical*
automated checks a registry review runs, locally, so "green locally" predicts
"passes review."

Engineering spec: [`docs/SPEC.md`](docs/SPEC.md) · Build plan:
[`docs/specs/cli-v0/spec.md`](docs/specs/cli-v0/spec.md).

> **Status: scaffold.** The command surface below is wired and documented, but
> the commands are stubs that print a "not yet implemented" notice — behavior
> lands across the cli-v0 milestones (SPEC §10). Track progress in the repo's
> issues.

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
