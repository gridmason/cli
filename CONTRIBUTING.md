# Contributing to `@gridmason/cli`

Thanks for your interest in contributing. `@gridmason/cli` ships the `gridmason`
binary: the widget-author devkit (`init` / `dev` / `lint`) and the publish path
(`login` / `publish` / `verify` / `bundle`) into a Gridmason Registry. Its `lint`
checks are the **same code the registry runs at review time** — so correctness
and cross-tool consistency matter here more than in a typical CLI.

Please also read our [Code of Conduct](./CODE_OF_CONDUCT.md) and
[Security Policy](./SECURITY.md). Never file a suspected vulnerability as a public
issue or PR — follow [SECURITY.md](./SECURITY.md) instead.

## Contributor License Agreement (required)

Gridmason is released under [AGPL-3.0](./LICENSE), and Sniper7Kills LLC offers it
under separate commercial terms as well. To keep dual licensing possible, **every
contributor must sign the [Contributor License Agreement](./.github/CLA.md)**
before their pull request can be merged.

You do not need to do anything up front. When you open your first pull request, a
bot comments with the CLA text and a one-line instruction; you sign by replying
with the exact sentence it gives you. The signature is recorded once and applies
to all your future contributions. PRs from unsigned contributors are blocked from
merging until the CLA is signed.

## Development setup

Requirements: **Node.js >= 22** (the package targets modern ESM; see `engines` in
`package.json`) and npm.

```bash
git clone https://github.com/gridmason/cli.git
cd cli
npm ci          # install exact, locked dependencies
```

Local checks — these are exactly what CI runs, and all four must be green before
you open a PR:

```bash
npm run build       # tsc -> dist/ (ESM + type declarations, including the bin)
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run lint        # eslint
```

Useful during development:

```bash
npm run test:watch  # vitest in watch mode
npm run coverage    # vitest with coverage
npm run lint:fix    # auto-fix lint issues
node dist/bin/gridmason.js --help   # drive the built binary locally
```

## How the CLI is structured

- `src/bin/gridmason.ts` — the binary entry. Thin: it parses and dispatches, then
  sets the exit code. All real logic lives in the library so it stays testable.
- `src/cli.ts` — builds the command program and exposes `run()` / `buildProgram()`.
  Output is threaded through an `IO` sink (`src/io.ts`) so the whole CLI is
  drivable in a unit test with no child process; **prefer `io.out` / `io.err`
  over `console` / `process.stdout`** so command output stays capturable.
- `src/commands/` — one module per command, each returning a configured
  `commander` `Command`. Global flags (`--registry`, `--json`, `--offline`) come
  from `commands/global-options.ts`.
- `src/checks/` — the **shared review checks** (SPEC §5, §8). The registry service
  imports this module so local `lint` and server review run the same code. A
  change to a check must keep the two in lockstep; divergence is a bug.
- `src/templates/` — `init` scaffold templates. `src/publish/` — the sign/upload
  path (Phase B).

Keep new commands consistent: register them in `src/commands/index.ts`, add the
global flags via `addGlobalOptions`, and cover the router wiring with a unit test
in `test/`.

## Changesets (required on user-facing changes)

This package publishes to npm via [changesets](https://github.com/changesets/changesets)
with SemVer. **Any change that affects users — a command, a flag, output shape, the
exported library API, or runtime behavior — must include a changeset:**

```bash
npx changeset
```

Pick the bump that matches the impact:

- **patch** — bug fix with no surface change.
- **minor** — additive, backward-compatible change (a new command, a new flag).
- **major** — a breaking change. Pre-1.0, breaking changes bump the `0.x` minor
  per SemVer's 0.x rules; call them out clearly in the changeset regardless.

Changesets are **not** required for changes with no user impact (internal
refactors with identical behavior, tests, CI, or documentation). If in doubt, add
one.

## Pull request checklist

- [ ] `npm run build && npm run typecheck && npm test && npm run lint` all pass.
- [ ] Tests added/updated for new command wiring or behavior.
- [ ] A changeset is included if the change is user-facing.
- [ ] The CLA is signed (the bot will guide you on your first PR).
- [ ] For a `lint`/`checks` change: the shared-checks contract with the registry
      is preserved (or the cross-repo change is filed as an issue in the affected
      repo — we do **not** do coordinated cross-repo merges).

Small, focused PRs review faster. For anything significant — a new command, a
change to the shared checks, or a dependency on the verify path — opening an issue
to discuss the approach first is welcome.

## License

By contributing, you agree that your contributions are licensed under the
project's [AGPL-3.0](./LICENSE) license and are covered by the terms of the
[CLA](./.github/CLA.md) you signed.
