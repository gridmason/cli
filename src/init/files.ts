/**
 * The non-framework-specific scaffold files (FR-2) and the assembly that stitches
 * them together with the framework template's files (#7) and the seeded fixtures
 * (#8). Everything here is product-neutral: the manifest, a JSON-schema'd props
 * file, a thumbnail placeholder, a Storybook story stub, a CI workflow that calls
 * `gridmason lint`, and the project's `package.json` / `README` / `.gitignore`.
 */
import type { Manifest } from '@gridmason/protocol';
import { getTemplate, type GeneratedFile, type TemplateContext } from '../templates/index.js';
import { buildManifestStub, slugify, toClassName, type InitAnswers } from './manifest.js';
import { seedFixtures } from './fixtures.js';

/** A fully planned scaffold: where it goes and every file it writes. */
export interface Scaffold {
  /** Project directory base (the slug), relative to the invocation cwd. */
  directory: string;
  /** The generated manifest (for reporting the tag, etc.). */
  manifest: Manifest;
  /** Every file to write, project-relative. */
  files: GeneratedFile[];
}

/** Serialize an object as pretty JSON with a trailing newline. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The manifest file itself. */
function manifestFile(manifest: Manifest): GeneratedFile {
  return { path: 'manifest.json', contents: json(manifest) };
}

/** A valid, empty JSON Schema (draft-07) for the widget's user-facing settings. */
function propsSchemaFile(manifest: Manifest): GeneratedFile {
  return {
    path: manifest.props ?? 'props.schema.json',
    contents: json({
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: `${manifest.name} settings`,
      description: 'User-facing settings for this widget. Add properties as the widget grows.',
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
  };
}

/**
 * A neutral 1:1 thumbnail placeholder (SVG so it stays tiny and text-diffable).
 * The author replaces it before publishing; a placeholder keeps the manifest's
 * `thumbnail` path valid from the first `lint`.
 */
function thumbnailFile(manifest: Manifest): GeneratedFile {
  const label = manifest.tag;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="${label} thumbnail placeholder">
  <rect width="256" height="256" fill="#e2e8f0"/>
  <text x="128" y="132" font-family="sans-serif" font-size="16" fill="#475569" text-anchor="middle">${label}</text>
</svg>
`;
  return { path: manifest.thumbnail ?? 'thumbnail.svg', contents: svg };
}

/**
 * A framework-agnostic Storybook story stub. The widget is a custom element, so
 * the story imports the `entry` (which registers the tag) and renders the tag —
 * this works for any framework's `entry`. #7's templates may add richer stories.
 */
function storyFile(ctx: TemplateContext): GeneratedFile {
  const { manifest, slug } = ctx;
  const entry = getTemplate(ctx.framework).entryPath;
  // Relative import from the story (in src/) to the entry (also in src/).
  const entryImport = `./${entry.replace(/^src\//, '')}`;
  const contents = `// Storybook CSF story stub. The widget is a custom element, so this registers
// it via the entry module and renders the tag. \`gridmason dev\` is the primary
// author loop (SPEC §4); this story is a static render surface for Storybook.
import '${entryImport}';

export default {
  title: 'Widgets/${manifest.name}',
};

export const Default = {
  render: () => document.createElement('${manifest.tag}'),
};
`;
  return { path: `src/${slug}.stories.js`, contents };
}

/**
 * The scaffolded project's CI workflow — fails a PR on a lint violation before a
 * registry review ever sees it (SPEC §3). Phase A runs plain `gridmason lint`;
 * the `--registry` capability diff is a Phase B concern.
 */
function ciWorkflowFile(): GeneratedFile {
  const contents = `name: widget CI

on:
  push:
  pull_request:

jobs:
  lint:
    name: gridmason lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx gridmason lint --json
`;
  return { path: '.github/workflows/ci.yml', contents };
}

/** The scaffolded project's `package.json`. */
function packageJsonFile(manifest: Manifest, slug: string): GeneratedFile {
  const pkg = {
    name: slug,
    version: manifest.version,
    private: true,
    type: 'module',
    scripts: {
      dev: 'gridmason dev',
      lint: 'gridmason lint',
    },
    dependencies: {
      '@gridmason/sdk': '^0.4.0',
    },
    devDependencies: {
      '@gridmason/cli': '^0.0.0',
    },
  };
  return { path: 'package.json', contents: json(pkg) };
}

/** A short authoring README for the scaffolded project. */
function readmeFile(manifest: Manifest): GeneratedFile {
  const contents = `# ${manifest.name}

A Gridmason \`${manifest.kind}\` scaffolded with \`gridmason widget init\`.

- **Tag:** \`${manifest.tag}\`
- **Entry:** \`${manifest.entry}\` (a plain ES module that registers the custom element)

## Develop

\`\`\`bash
npm install
gridmason dev      # serve the entry for the dashboard's dev sideload
gridmason lint     # run the same checks the registry review runs
\`\`\`

Fixtures under \`fixtures/\` supply sample data to \`gridmason dev\` so the widget
renders before you write any code. Edit \`src/entry.js\`, \`manifest.json\`, and
\`props.schema.json\` to build out the widget.
`;
  return { path: 'README.md', contents };
}

/** The scaffolded project's `.gitignore`. */
function gitignoreFile(): GeneratedFile {
  return { path: '.gitignore', contents: 'node_modules/\ndist/\n' };
}

/**
 * Plan the full scaffold for the given answers: build the manifest stub, gather
 * the template's framework files, the non-framework files, and the seeded
 * fixtures into one ordered file list. Pure — writes nothing (see `scaffold.ts`).
 */
export function planScaffold(answers: InitAnswers): Scaffold {
  const manifest = buildManifestStub(answers);
  const slug = slugify(answers.name);
  const template = getTemplate(answers.framework);
  const ctx: TemplateContext = {
    manifest,
    framework: answers.framework,
    slug,
    className: toClassName(slug),
  };

  const files: GeneratedFile[] = [
    manifestFile(manifest),
    ...template.files(ctx),
    propsSchemaFile(manifest),
    thumbnailFile(manifest),
    storyFile(ctx),
    ciWorkflowFile(),
    packageJsonFile(manifest, slug),
    readmeFile(manifest),
    gitignoreFile(),
    ...seedFixtures(ctx),
  ];

  return { directory: slug, manifest, files };
}
