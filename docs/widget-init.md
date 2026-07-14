# `gridmason widget init`

Scaffold a ready-to-develop widget/plugin/page-type/layout project, wired to the
Gridmason contracts (SPEC §3, FR-2). The generated project passes `gridmason
lint` out of the box: the manifest is schema-valid and its custom-element tag is
publisher-prefixed — the prefix rule is enforced **at creation**, via the
protocol's own `lintTag`, so a scaffold can never emit a manifest that would fail
review.

```bash
gridmason widget init [name] [--publisher <prefix>] [--kind <kind>] [--framework <name>]
```

## Prompts & flags

Run interactively, `init` prompts for anything not supplied as a flag. Run
non-interactively (no TTY, e.g. CI) it takes every answer from flags and **errors
instead of prompting** if a required one is missing.

| Answer | Flag | Prompted? | Default | Notes |
|---|---|---|---|---|
| Name | `[name]` argument | yes (required) | — | Human name; slugified for the tag and project directory. |
| Publisher prefix | `--publisher <prefix>` | yes (required) | — | The tag becomes `<publisher>-<slug>`; must be lowercase `[a-z0-9-]`, starting with a letter. |
| Kind | `--kind <kind>` | yes | `widget` | One of `widget`, `plugin`, `page-type`, `layout` (mirrors the manifest `kind`). |
| Framework | `--framework <name>` | yes | `vanilla` | One of `vanilla`, `react`, `vue`. Sets the manifest `sharedScope` defaults. |

Global flags apply: `--json` emits a machine-readable result (and machine-readable
errors) on stdout; `--registry` / `--offline` are accepted for surface
consistency.

`init` refuses to write into a directory that already exists and is not empty —
it never clobbers an existing project.

## Generated file map

For `gridmason widget init "Sales Chart" --publisher acme`, the project directory
`sales-chart/` contains:

| File | Purpose |
|---|---|
| `manifest.json` | The manifest stub (protocol §3.1): publisher-prefixed `tag`, `entry`, `props`, `thumbnail`, a `size` default, a sample `requiresContext` slot, and a matching `records.read` capability. `sharedScope` is set for React/Vue. |
| `src/entry.js` | The ES-module `entry` that registers the custom element (from the chosen framework template). |
| `props.schema.json` | A draft-07 JSON Schema for the widget's user-facing settings (empty to start). |
| `thumbnail.svg` | A neutral thumbnail placeholder, so the manifest's `thumbnail` path is valid from the first lint. |
| `src/<slug>.stories.js` | A framework-agnostic Storybook story stub that renders the custom element by tag. |
| `.github/workflows/ci.yml` | CI that runs `gridmason lint` on every push/PR — fails the PR before a registry review ever sees it. |
| `fixtures/` | Seeded sample data for `gridmason dev` — `default.json` plus a `contexts/` preset, derived from the manifest ([fixtures](./fixtures.md)). |
| `package.json` | Project manifest with `dev`/`lint` scripts and the `@gridmason/sdk` + `@gridmason/cli` deps. |
| `README.md`, `.gitignore` | Authoring readme and standard ignores. |

## Extension seams

`init` owns orchestration and the non-framework-specific files; the
framework-specific bodies come from a sibling seam:

- **Framework template bodies** (`src/templates/index.ts`, issue #7) — the
  `Template` registry maps each framework to its `entry`/ABI-skeleton files and
  its `sharedScope` defaults. Until #7 lands, every framework shares a minimal
  placeholder `entry` that registers the element.

The **fixture seeding** seam (`src/init/fixtures.ts`) is filled: `seedFixtures(ctx)`
derives `fixtures/` from the manifest — a sample record per `requiresContext`
recordType, a `net` stub per `net:<host>` capability, a scripted emission per
`events:<ns>` capability, and a default + named context preset — so the first
`gridmason dev` renders with data. See [fixtures](./fixtures.md) for the layout
and the full seed-from-manifest mapping.
