import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lintTag, type Manifest } from '@gridmason/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IO } from '../src/io.js';
import { runInit } from '../src/init/index.js';
import { buildManifestStub, InitError, slugify, toClassName, type InitAnswers } from '../src/init/manifest.js';
import { planScaffold } from '../src/init/files.js';
import type { Choice, Prompter } from '../src/init/prompter.js';

const require = createRequire(import.meta.url);

/** The shipped manifest JSON Schema — the authoritative shape, never re-declared here. */
const manifestSchema = JSON.parse(
  readFileSync(require.resolve('@gridmason/protocol/schemas/manifest.json'), 'utf8'),
) as {
  definitions: {
    Manifest: {
      required: string[];
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
  };
};

/** A capturing IO sink. */
function capture(): { io: IO; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: { out: (s) => outChunks.push(s), err: (s) => errChunks.push(s) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

const baseAnswers: InitAnswers = {
  name: 'Sales Chart',
  publisher: 'acme',
  kind: 'widget',
  framework: 'vanilla',
};

describe('slugify / toClassName', () => {
  it('lowercases, hyphenates, and trims', () => {
    expect(slugify('Sales Chart!')).toBe('sales-chart');
    expect(slugify('  Multi   Word  ')).toBe('multi-word');
    expect(slugify('already-good')).toBe('already-good');
  });

  it('is empty for a name with no alphanumerics', () => {
    expect(slugify('!!!')).toBe('');
  });

  it('PascalCases a slug', () => {
    expect(toClassName('sales-chart')).toBe('SalesChart');
  });
});

describe('buildManifestStub', () => {
  it('produces a publisher-prefixed, lint-clean manifest', () => {
    const manifest = buildManifestStub(baseAnswers);
    expect(manifest.tag).toBe('acme-sales-chart');
    expect(manifest.publisher).toBe('acme');
    expect(lintTag(manifest.tag, manifest.publisher).ok).toBe(true);
    expect(manifest.kind).toBe('widget');
    expect(manifest.entry).toBe('src/entry.js');
    expect(manifest.props).toBe('props.schema.json');
    expect(manifest.thumbnail).toBe('thumbnail.svg');
  });

  it('conforms to the shipped manifest JSON Schema shape', () => {
    const manifest = buildManifestStub(baseAnswers) as unknown as Record<string, unknown>;
    const { required, properties } = manifestSchema.definitions.Manifest;

    // Every required field is present…
    for (const key of required) {
      expect(manifest[key], `required field "${key}"`).toBeDefined();
    }
    // …and no field lies outside the schema (additionalProperties: false).
    expect(manifestSchema.definitions.Manifest.additionalProperties).toBe(false);
    for (const key of Object.keys(manifest)) {
      expect(Object.keys(properties), `unexpected field "${key}"`).toContain(key);
    }
    // Pattern-constrained fields match.
    expect(manifest['formatVersion']).toMatch(/^\d+\.\d+$/);
    expect(manifest['version']).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('sets sharedScope defaults per framework', () => {
    expect(buildManifestStub({ ...baseAnswers, framework: 'vanilla' }).sharedScope).toBeUndefined();
    expect(buildManifestStub({ ...baseAnswers, framework: 'react' }).sharedScope).toEqual({
      react: '^18.0.0',
      'react-dom': '^18.0.0',
    });
    expect(buildManifestStub({ ...baseAnswers, framework: 'vue' }).sharedScope).toEqual({ vue: '^3.0.0' });
  });

  it('seeds a sample context slot and a matching capability', () => {
    const manifest = buildManifestStub(baseAnswers);
    expect(manifest.requiresContext).toEqual({ primary: { recordType: 'example' } });
    expect(manifest.capabilities).toEqual([{ api: 'records.read', scope: 'recordType:example' }]);
  });

  it('carries the kind through', () => {
    expect(buildManifestStub({ ...baseAnswers, kind: 'page-type' }).kind).toBe('page-type');
  });

  it('rejects a name with no usable slug', () => {
    expect(() => buildManifestStub({ ...baseAnswers, name: '!!!' })).toThrow(InitError);
    try {
      buildManifestStub({ ...baseAnswers, name: '!!!' });
    } catch (err) {
      expect((err as InitError).code).toBe('invalid-name');
    }
  });

  it('rejects a non-prefixable publisher via the protocol tag lint', () => {
    // An uppercase publisher yields a non-lowercase tag — rejected at creation.
    try {
      buildManifestStub({ ...baseAnswers, publisher: 'Acme' });
      throw new Error('expected InitError');
    } catch (err) {
      expect(err).toBeInstanceOf(InitError);
      expect((err as InitError).code).toBe('invalid-tag');
    }
  });
});

describe('planScaffold', () => {
  it('emits the full non-framework file set plus the template entry and fixtures seam', () => {
    const { directory, files } = planScaffold(baseAnswers);
    expect(directory).toBe('sales-chart');
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        '.github/workflows/ci.yml',
        '.gitignore',
        'README.md',
        'fixtures/contexts/example-2.json',
        'fixtures/default.json',
        'manifest.json',
        'package.json',
        'props.schema.json',
        'src/entry.js',
        'src/sales-chart.stories.js',
        'thumbnail.svg',
      ].sort(),
    );
  });

  it('the CI workflow calls `gridmason lint`', () => {
    const ci = planScaffold(baseAnswers).files.find((f) => f.path === '.github/workflows/ci.yml');
    expect(ci?.contents).toContain('gridmason lint');
  });

  it('the props file is a valid draft-07 JSON Schema', () => {
    const props = planScaffold(baseAnswers).files.find((f) => f.path === 'props.schema.json');
    const parsed = JSON.parse(props!.contents) as { $schema: string; type: string };
    expect(parsed.$schema).toContain('json-schema.org');
    expect(parsed.type).toBe('object');
  });

  it('the entry registers the manifest tag', () => {
    const entry = planScaffold(baseAnswers).files.find((f) => f.path === 'src/entry.js');
    expect(entry?.contents).toContain("customElements.define('acme-sales-chart'");
  });
});

describe('runInit (filesystem)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gm-init-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a scaffold whose manifest lints clean', async () => {
    const cap = capture();
    const code = await runInit(
      { name: 'Sales Chart', publisher: 'acme', kind: 'widget', framework: 'vanilla', json: true, cwd: dir },
      cap.io,
      { isTTY: false },
    );
    expect(code).toBe(0);

    const report = JSON.parse(cap.out()) as { status: string; directory: string; tag: string };
    expect(report.status).toBe('created');
    expect(report.tag).toBe('acme-sales-chart');

    const manifestRaw = await readFile(path.join(dir, 'sales-chart', 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as Manifest;
    expect(lintTag(manifest.tag, manifest.publisher).ok).toBe(true);

    // The referenced files actually exist on disk.
    await expect(readFile(path.join(dir, 'sales-chart', manifest.entry), 'utf8')).resolves.toContain('customElements');
    await expect(readFile(path.join(dir, 'sales-chart', manifest.props!), 'utf8')).resolves.toContain('json-schema');
    await expect(readFile(path.join(dir, 'sales-chart', manifest.thumbnail!), 'utf8')).resolves.toContain('<svg');
  });

  it('refuses to scaffold into a non-empty directory', async () => {
    const opts = { name: 'Sales Chart', publisher: 'acme', json: true, cwd: dir };
    expect(await runInit(opts, capture().io, { isTTY: false })).toBe(0);

    const cap = capture();
    const code = await runInit(opts, cap.io, { isTTY: false });
    expect(code).toBe(1);
    expect((JSON.parse(cap.out()) as { code: string }).code).toBe('dir-not-empty');
  });

  it('errors (does not prompt) when non-interactive and a required answer is missing', async () => {
    const cap = capture();
    const code = await runInit({ name: 'Sales Chart', json: true, cwd: dir }, cap.io, { isTTY: false });
    expect(code).toBe(1);
    expect((JSON.parse(cap.out()) as { code: string }).code).toBe('missing-answer');
  });

  it('rejects an unknown framework flag', async () => {
    const cap = capture();
    const code = await runInit(
      { name: 'Sales Chart', publisher: 'acme', framework: 'svelte', json: true, cwd: dir },
      cap.io,
      { isTTY: false },
    );
    expect(code).toBe(1);
    expect((JSON.parse(cap.out()) as { code: string }).code).toBe('invalid-option');
  });
});

describe('runInit (interactive)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gm-init-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A scripted prompter returning canned answers, so the interactive path is drivable. */
  function scriptedPrompter(answers: { text: string[]; select: string[] }): Prompter {
    const text = [...answers.text];
    const select = [...answers.select];
    return {
      text: () => Promise.resolve(text.shift() ?? ''),
      select: <T extends string>(opts: { choices: Choice<T>[]; default: T }) => {
        const next = select.shift();
        const found = opts.choices.find((c) => c.value === next);
        return Promise.resolve(found ? found.value : opts.default);
      },
      close: () => {},
    };
  }

  it('scaffolds from prompted answers when no flags are given', async () => {
    const cap = capture();
    const prompter = scriptedPrompter({ text: ['Prompted Widget', 'acme'], select: ['widget', 'vue'] });
    const code = await runInit({ json: true, cwd: dir }, cap.io, { isTTY: true, prompter });
    expect(code).toBe(0);

    const report = JSON.parse(cap.out()) as { tag: string; framework: string; directory: string };
    expect(report.tag).toBe('acme-prompted-widget');
    expect(report.framework).toBe('vue');

    const manifest = JSON.parse(
      await readFile(path.join(dir, 'prompted-widget', 'manifest.json'), 'utf8'),
    ) as Manifest;
    expect(manifest.sharedScope).toEqual({ vue: '^3.0.0' });
  });
});
