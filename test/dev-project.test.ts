import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planScaffold } from '../src/init/files.js';
import { writeProject } from '../src/init/scaffold.js';
import { FRAMEWORKS } from '../src/templates/index.js';
import { harnessBareSpecifiers } from '../src/dev/harness.js';
import {
  DevProjectError,
  declaredCapabilities,
  loadContext,
  loadFixtures,
  loadManifest,
  resolveProject,
} from '../src/dev/project.js';
import { categorize } from '../src/dev/watch.js';

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gm-dev-proj-'));
  const scaffold = planScaffold({ name: 'Sales Chart', publisher: 'acme', kind: 'widget', framework: 'vanilla' });
  root = path.join(dir, scaffold.directory);
  await writeProject(root, scaffold.files);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadManifest', () => {
  it('validates a fresh scaffold as clean and exposes tag + capabilities', async () => {
    const state = await loadManifest(resolveProject(root));
    expect(state.valid).toBe(true);
    expect(state.violations).toEqual([]);
    expect(state.manifest?.tag).toBe('acme-sales-chart');
    expect(declaredCapabilities(state)).toEqual([{ api: 'records.read', scope: 'recordType:example' }]);
  });

  it('re-validates live: a broken tag is reported on the next read', async () => {
    const manifestPath = path.join(root, 'manifest.json');
    const state = await loadManifest(resolveProject(root));
    const broken = { ...state.manifest, tag: 'Bad Tag', publisher: 'acme' };
    await writeFile(manifestPath, JSON.stringify(broken), 'utf8');

    const after = await loadManifest(resolveProject(root));
    expect(after.valid).toBe(false);
    expect(after.violations.join(' ')).toMatch(/tag "Bad Tag"/);
  });

  it('reports invalid JSON rather than throwing', async () => {
    await writeFile(path.join(root, 'manifest.json'), '{ not json', 'utf8');
    const state = await loadManifest(resolveProject(root));
    expect(state.valid).toBe(false);
    expect(state.manifest).toBeNull();
    expect(state.violations.join(' ')).toMatch(/not valid JSON/);
  });

  it('reports a missing manifest with raw=null', async () => {
    await rm(path.join(root, 'manifest.json'));
    const state = await loadManifest(resolveProject(root));
    expect(state.raw).toBeNull();
    expect(state.valid).toBe(false);
  });
});

describe('loadFixtures', () => {
  it('reads the seeded default fixture and originates nothing extra', async () => {
    const fixtures = await loadFixtures(resolveProject(root));
    expect(fixtures.records?.read?.[0]?.ref).toEqual({ recordType: 'example' });
    expect(fixtures.context).toEqual({ primary: { recordType: 'example', id: 'example-1' } });
  });

  it('returns the empty fixture when default.json is absent (no built-in data)', async () => {
    await rm(path.join(root, 'fixtures/default.json'));
    expect(await loadFixtures(resolveProject(root))).toEqual({});
  });
});

describe('loadContext', () => {
  it("uses default.json's context when no preset is named", async () => {
    const active = await loadContext(resolveProject(root));
    expect(active.source).toBe('default');
    expect(active.context).toEqual({ primary: { recordType: 'example', id: 'example-1' } });
  });

  it('loads a named preset and marks it as the source', async () => {
    const active = await loadContext(resolveProject(root), 'example-2');
    expect(active.source).toBe('preset');
    expect(active.name).toBe('example-2');
    expect(active.context).toEqual({ primary: { recordType: 'example', id: 'example-2' } });
  });

  it('throws context-not-found for a preset that does not exist', async () => {
    await expect(loadContext(resolveProject(root), 'nope')).rejects.toMatchObject({
      name: 'DevProjectError',
      code: 'context-not-found',
    });
  });
});

describe('categorize', () => {
  it('maps each watched path to its reload category', () => {
    expect(categorize(root, path.join(root, 'manifest.json'))).toBe('manifest');
    expect(categorize(root, path.join(root, 'fixtures/contexts/example-2.json'))).toBe('context');
    expect(categorize(root, path.join(root, 'fixtures/default.json'))).toBe('fixtures');
    expect(categorize(root, path.join(root, 'src/entry.js'))).toBe('source');
  });
});

describe('harness import map covers the templates’ @gridmason imports', () => {
  // The fixture harness mounts a scaffolded entry as plain browser ESM, so every
  // bare `@gridmason/*` specifier a template imports must be in the harness import
  // map — otherwise the browser cannot resolve it and the mount fails. (This is
  // the contract that broke when the templates began consuming real SDK helpers.)
  const covered = new Set(harnessBareSpecifiers());

  for (const framework of FRAMEWORKS) {
    it(`resolves every @gridmason specifier the ${framework} template imports`, () => {
      const scaffold = planScaffold({ name: 'Cov', publisher: 'acme', kind: 'widget', framework });
      const specifiers = new Set<string>();
      for (const file of scaffold.files) {
        for (const match of file.contents.matchAll(/from\s+['"](@gridmason\/[^'"]+)['"]/g)) {
          specifiers.add(match[1]!);
        }
      }
      expect(specifiers.size).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(covered, `harness import map is missing "${specifier}"`).toContain(specifier);
      }
    });
  }
});

describe('DevProjectError', () => {
  it('carries a stable code', () => {
    const err = new DevProjectError('no-manifest', 'x');
    expect(err.code).toBe('no-manifest');
    expect(err.name).toBe('DevProjectError');
  });
});
