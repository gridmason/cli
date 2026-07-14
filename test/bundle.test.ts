import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalize, hashBytes, VERIFY_BUNDLE_REASONS, type MultihashString } from '@gridmason/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import type { IO } from '../src/io.js';
import {
  assembleBundle,
  runBundleExport,
  runBundleInspect,
  type BundleExportDeps,
  type BundleInspectDeps,
} from '../src/bundle/index.js';

const REGISTRY = 'registry.example';
const ROOT_A = 'ROOT-A';
const ARTIFACT_ID = 'acme-chart@1.0.0';
const ISSUER = 'https://accounts.example';

/** The four servable files a fixture project ships, exercising every payload section. */
const PROJECT_FILES: Record<string, string> = {
  'index.js': 'export const entry = 1;',
  'chunk.js': 'export const chunk = 2;',
  'settings.schema.json': '{"type":"object"}',
  'README.md': '# widget docs',
};
const MANIFEST = { formatVersion: '1.0', tag: 'acme-chart', kind: 'widget', name: 'Acme Chart', publisher: 'acme', version: '1.0.0', entry: 'index.js', props: 'settings.schema.json' };

function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/** Build the signed-release document (the shape the online `verify` source and a registry serve) over the fixture files. */
async function buildSignedRelease(files: Record<string, string> = PROJECT_FILES): Promise<Record<string, unknown>> {
  const fileHashes: Record<string, MultihashString> = {};
  for (const [p, content] of Object.entries(files)) fileHashes[p] = await hashBytes(bytesOf(content));
  const release = { formatVersion: '1.0', artifact: ARTIFACT_ID, files: fileHashes };
  const releaseHash = await hashBytes(canonicalize(release));
  return {
    release,
    envelope: {
      formatVersion: '1.0',
      subject: { artifact: ARTIFACT_ID, releaseHash },
      publisherSig: { alg: 'ES256', cert: 'x', issuer: ISSUER, subjectClaims: { sub: 'dev@acme' }, sig: 'AA' },
      logInclusion: { logId: 'a'.repeat(64), index: 0, proof: [] },
    },
    logEntry: {
      logId: 'a'.repeat(64),
      index: 0,
      integratedTime: 1234,
      canonicalBody: '',
      inclusionProof: { treeSize: 1, rootHash: '0'.repeat(64), hashes: [] },
      checkpoint: 'origin\n1\nAAAA\n',
    },
    trustRoot: {
      formatVersion: '1.0',
      registryId: REGISTRY,
      countersignRoots: [ROOT_A],
      issuerAllowlist: [ISSUER],
      logPublicKeys: [],
      notBefore: 0,
      notAfter: 9e15,
    },
  };
}

function trustConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pins: [{ registryId: REGISTRY, root: ROOT_A, channel: 'deploy-time' }],
    publisherCARoots: [],
    countersignRoots: [],
    logPublicKey: { name: 'log', key: Buffer.alloc(32).toString('base64') },
    ...overrides,
  });
}

const PROJECT = '/proj';

/** In-memory export deps: text files (read+write share one map), servable bytes, and a URL fetch stub. */
function memExportDeps(opts: {
  text?: Record<string, string>;
  bytes?: Record<string, string>;
  fetch?: Record<string, string>;
  env?: Record<string, string>;
} = {}): BundleExportDeps & { text: Map<string, string> } {
  const text = new Map<string, string>(Object.entries(opts.text ?? {}));
  const bytes = new Map<string, Uint8Array>(Object.entries(opts.bytes ?? {}).map(([k, v]) => [k, bytesOf(v)]));
  return {
    text,
    readText: async (f) => {
      const v = text.get(f);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${f}`), { code: 'ENOENT' });
      return v;
    },
    readBytes: async (f) => {
      const v = bytes.get(f);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${f}`), { code: 'ENOENT' });
      return v;
    },
    fetchText: async (url) => {
      const v = opts.fetch?.[url];
      if (v === undefined) throw new Error(`no such url ${url}`);
      return v;
    },
    writeText: async (f, data) => {
      text.set(f, data);
    },
    env: (name) => opts.env?.[name],
    now: () => 1_000_000,
  };
}

/** Wire a project's manifest + servable bytes + signed release into an export deps harness. */
async function projectDeps(extra: { text?: Record<string, string>; env?: Record<string, string> } = {}): Promise<BundleExportDeps & { text: Map<string, string> }> {
  const signed = await buildSignedRelease();
  const text: Record<string, string> = {
    [path.join(PROJECT, 'manifest.json')]: JSON.stringify(MANIFEST),
    '/release.json': JSON.stringify(signed),
    ...extra.text,
  };
  const bytes: Record<string, string> = {};
  for (const [p, content] of Object.entries(PROJECT_FILES)) bytes[path.join(PROJECT, p)] = content;
  return memExportDeps({ text, bytes, ...(extra.env ? { env: extra.env } : {}) });
}

describe('runBundleExport — assemble, seal, self-check', () => {
  it('exports a self-consistent bundle and passes the pinless structural self-check', async () => {
    const deps = await projectDeps();
    const render = await runBundleExport(deps, { project: PROJECT, release: '/release.json', output: '/out.gmb', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string; fileCount: number; selfCheck: { mode: string }; artifact: string; producedBy: string };
    expect(render.exitCode).toBe(0);
    expect(parsed.status).toBe('exported');
    expect(parsed.artifact).toBe(ARTIFACT_ID);
    expect(parsed.producedBy).toBe(REGISTRY);
    expect(parsed.fileCount).toBe(4);
    expect(parsed.selfCheck.mode).toBe('structural');
    // The bundle was actually written and is JSON with the sealed shape.
    const written = JSON.parse(deps.text.get('/out.gmb') as string) as { formatVersion: string; contentHash: string; payload: { chunks: unknown[]; schemas: unknown[]; docs: unknown[] } };
    expect(written.formatVersion).toBe('1.0');
    expect(written.contentHash).toMatch(/^sha2-256:[0-9a-f]{64}$/);
    // Files landed in the right sections (entry/chunk/schema/doc classification).
    expect(written.payload.chunks).toHaveLength(1);
    expect(written.payload.schemas).toHaveLength(1);
    expect(written.payload.docs).toHaveLength(1);
  });

  it('defaults the output name to <artifact>.gmb', async () => {
    const deps = await projectDeps();
    await runBundleExport(deps, { project: PROJECT, release: '/release.json', json: true });
    expect(deps.text.has('acme-chart@1.0.0.gmb')).toBe(true);
  });

  it('refuses when a released file is absent from the project (file-unreadable)', async () => {
    // A project missing one servable the signed release commits to.
    const signed = await buildSignedRelease();
    const text = { [path.join(PROJECT, 'manifest.json')]: JSON.stringify(MANIFEST), '/release.json': JSON.stringify(signed) };
    const bytes: Record<string, string> = {};
    for (const [p, content] of Object.entries(PROJECT_FILES)) if (p !== 'chunk.js') bytes[path.join(PROJECT, p)] = content;
    const partial = memExportDeps({ text, bytes });
    const render = await runBundleExport(partial, { project: PROJECT, release: '/release.json', output: '/out.gmb', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string; reason: string };
    expect(render.exitCode).toBe(1);
    expect(parsed.status).toBe('refused');
    expect(parsed.reason).toBe('file-unreadable');
  });

  it('refuses when manifest.entry is not among the signed release files (entry-not-in-release)', async () => {
    const signed = await buildSignedRelease();
    const badManifest = { ...MANIFEST, entry: 'nope.js' };
    const text = { [path.join(PROJECT, 'manifest.json')]: JSON.stringify(badManifest), '/release.json': JSON.stringify(signed) };
    const bytes: Record<string, string> = {};
    for (const [p, content] of Object.entries(PROJECT_FILES)) bytes[path.join(PROJECT, p)] = content;
    const deps = memExportDeps({ text, bytes });
    const render = await runBundleExport(deps, { project: PROJECT, release: '/release.json', output: '/out.gmb', json: true });
    const parsed = JSON.parse(render.stdout) as { reason: string };
    expect(render.exitCode).toBe(1);
    expect(parsed.reason).toBe('entry-not-in-release');
  });

  it('fails the self-check when a packed file does not match its signed hash (fail-closed)', async () => {
    const signed = await buildSignedRelease();
    const text = { [path.join(PROJECT, 'manifest.json')]: JSON.stringify(MANIFEST), '/release.json': JSON.stringify(signed) };
    const bytes: Record<string, string> = {};
    for (const [p, content] of Object.entries(PROJECT_FILES)) bytes[path.join(PROJECT, p)] = content;
    bytes[path.join(PROJECT, 'chunk.js')] = 'export const chunk = 999; // tampered, no longer hashes to the signed value';
    const deps = memExportDeps({ text, bytes });
    const render = await runBundleExport(deps, { project: PROJECT, release: '/release.json', output: '/out.gmb', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string; reason: string };
    expect(render.exitCode).toBe(1);
    expect(parsed.status).toBe('refused');
    expect(parsed.reason).toBe('self-check-failed');
  });

  it('errors (exit 2) when the manifest is missing', async () => {
    const signed = await buildSignedRelease();
    const deps = memExportDeps({ text: { '/release.json': JSON.stringify(signed) }, bytes: {} });
    const render = await runBundleExport(deps, { project: PROJECT, release: '/release.json', output: '/out.gmb', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string; code: string };
    expect(render.exitCode).toBe(2);
    expect(parsed.status).toBe('error');
    expect(parsed.code).toBe('manifest-unreadable');
  });

  it('refuses (exit 1) a manifest without a string entry', async () => {
    const signed = await buildSignedRelease();
    const deps = memExportDeps({
      text: { [path.join(PROJECT, 'manifest.json')]: JSON.stringify({ tag: 'x' }), '/release.json': JSON.stringify(signed) },
      bytes: {},
    });
    const render = await runBundleExport(deps, { project: PROJECT, release: '/release.json', output: '/out.gmb', json: true });
    const parsed = JSON.parse(render.stdout) as { reason: string };
    expect(render.exitCode).toBe(1);
    expect(parsed.reason).toBe('manifest-invalid');
  });

  it('errors (exit 2) when the signed release source is unreadable', async () => {
    const deps = memExportDeps({ text: { [path.join(PROJECT, 'manifest.json')]: JSON.stringify(MANIFEST) }, bytes: {} });
    const render = await runBundleExport(deps, { project: PROJECT, release: '/missing.json', output: '/out.gmb', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string; code: string };
    expect(render.exitCode).toBe(2);
    expect(parsed.status).toBe('error');
    expect(parsed.code).toBe('artifact-unreadable');
  });

  it('runs the full offline self-check when pinned roots are supplied (refuses on placeholder signatures, fail-closed)', async () => {
    const deps = await projectDeps({ text: { '/trust.json': trustConfig() } });
    const render = await runBundleExport(deps, { project: PROJECT, release: '/release.json', output: '/out.gmb', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string; reason: string; message: string };
    // With pins + placeholder sig material, the full chain refuses — export must not report success.
    expect(render.exitCode).toBe(1);
    expect(parsed.status).toBe('refused');
    expect(parsed.message).toContain('publisher-signature-invalid');
  });

  it('reads the signed release from a URL source (registry fetch path)', async () => {
    const signed = await buildSignedRelease();
    const text: Record<string, string> = { [path.join(PROJECT, 'manifest.json')]: JSON.stringify(MANIFEST) };
    const bytes: Record<string, string> = {};
    for (const [p, content] of Object.entries(PROJECT_FILES)) bytes[path.join(PROJECT, p)] = content;
    const deps = memExportDeps({ text, bytes, fetch: { 'https://registry.example/acme-chart': JSON.stringify(signed) } });
    const render = await runBundleExport(deps, { project: PROJECT, release: 'https://registry.example/acme-chart', output: '/out.gmb', json: true });
    expect(render.exitCode).toBe(0);
  });
});

describe('assembleBundle — sealing and classification (unit)', () => {
  it('produces a bundle whose content hash seals the canonical payload', async () => {
    const signed = await buildSignedRelease();
    const result = await assembleBundle({
      manifest: MANIFEST as never,
      signed: signed as never,
      readBytes: async (p) => bytesOf(PROJECT_FILES[p] ?? ''),
      producedBy: REGISTRY,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = await hashBytes(canonicalize(result.bundle.payload));
      expect(result.bundle.contentHash).toBe(expected);
      expect(result.bundle.payload.entry.path).toBe('index.js');
    }
  });

  it('refuses an empty release', async () => {
    const signed = await buildSignedRelease({});
    const result = await assembleBundle({ manifest: MANIFEST as never, signed: signed as never, readBytes: async () => bytesOf(''), producedBy: REGISTRY });
    expect(result).toMatchObject({ ok: false, code: 'release-empty' });
  });

  it('refuses an unsafe release path without echoing it', async () => {
    const signed = await buildSignedRelease({ 'index.js': 'x', '../escape.js': 'y' });
    const result = await assembleBundle({ manifest: MANIFEST as never, signed: signed as never, readBytes: async () => bytesOf('x'), producedBy: REGISTRY });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-path');
      expect(result.message).not.toContain('escape');
    }
  });
});

/** In-memory inspect deps over a fixed set of text files. */
function memInspectDeps(text: Record<string, string>, env: Record<string, string> = {}): BundleInspectDeps {
  const map = new Map(Object.entries(text));
  return {
    readText: async (f) => {
      const v = map.get(f);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${f}`), { code: 'ENOENT' });
      return v;
    },
    env: (name) => env[name],
    now: () => 1_000_000,
  };
}

/** Export a real `.gmb` (in-memory) and return its serialized text for inspect tests. */
async function exportedBundleText(): Promise<string> {
  const deps = await projectDeps();
  const render = await runBundleExport(deps, { project: PROJECT, release: '/release.json', output: '/out.gmb', json: true });
  expect(render.exitCode).toBe(0);
  return deps.text.get('/out.gmb') as string;
}

describe('runBundleInspect — contents + verdict', () => {
  it('prints the full inventory and an unverified verdict with no pinned roots', async () => {
    const gmb = await exportedBundleText();
    const deps = memInspectDeps({ '/out.gmb': gmb });
    const render = await runBundleInspect(deps, { ref: '/out.gmb', json: true });
    const parsed = JSON.parse(render.stdout) as {
      artifact: string;
      files: { entry: string; chunks: string[]; schemas: string[]; docs: string[]; total: number };
      identity: { issuer: string; countersigned: boolean; subjectClaims: Record<string, string> };
      inclusionProof: { logId: string; index: number; treeSize: number };
      trustRoot: { registryId: string; countersignRoots: string[] };
      verdict: { status: string };
    };
    expect(render.exitCode).toBe(0);
    expect(parsed.artifact).toBe(ARTIFACT_ID);
    expect(parsed.files.total).toBe(4);
    expect(parsed.files.entry).toBe('index.js');
    expect(parsed.files.schemas).toEqual(['settings.schema.json']);
    expect(parsed.files.docs).toEqual(['README.md']);
    expect(parsed.identity.issuer).toBe(ISSUER);
    expect(parsed.identity.subjectClaims).toEqual({ sub: 'dev@acme' });
    expect(parsed.identity.countersigned).toBe(false);
    expect(parsed.inclusionProof.logId).toBe('a'.repeat(64));
    expect(parsed.inclusionProof.treeSize).toBe(1);
    expect(parsed.trustRoot.registryId).toBe(REGISTRY);
    expect(parsed.trustRoot.countersignRoots).toEqual([ROOT_A]);
    expect(parsed.verdict.status).toBe('unverified');
  });

  it('renders the offline verdict (a stable refusal reason) when pinned roots are supplied', async () => {
    const gmb = await exportedBundleText();
    const deps = memInspectDeps({ '/out.gmb': gmb, '/trust.json': trustConfig() });
    const render = await runBundleInspect(deps, { ref: '/out.gmb', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { verdict: { status: string; reason: string } };
    expect(render.exitCode).toBe(1);
    expect(parsed.verdict.status).toBe('refused');
    expect(VERIFY_BUNDLE_REASONS).toContain(parsed.verdict.reason);
  });

  it('reaches the signature chain (archive + packed layers pass) for an exported bundle', async () => {
    // Round-trip proof: the bundle export produced verifies past the archive-integrity and
    // packed-byte gates into the signature chain — it is not rejected as tampered/malformed.
    const gmb = await exportedBundleText();
    const deps = memInspectDeps({ '/out.gmb': gmb, '/trust.json': trustConfig() });
    const render = await runBundleInspect(deps, { ref: '/out.gmb', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { verdict: { reason: string } };
    expect(parsed.verdict.reason).toBe('publisher-signature-invalid');
    expect(['bundle-hash-tampered', 'bundle-malformed']).not.toContain(parsed.verdict.reason);
  });

  it('flips to bundle-hash-tampered when the exported payload is mutated without resealing', async () => {
    const gmb = JSON.parse(await exportedBundleText()) as { contentHash: string; payload: { producedBy?: string; manifest: { name: string } } };
    gmb.payload.manifest = { ...gmb.payload.manifest, name: 'Tampered Name' };
    const deps = memInspectDeps({ '/tampered.gmb': JSON.stringify(gmb), '/trust.json': trustConfig() });
    const render = await runBundleInspect(deps, { ref: '/tampered.gmb', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { verdict: { reason: string } };
    expect(parsed.verdict.reason).toBe('bundle-hash-tampered');
  });

  it('errors (exit 2) on a non-JSON bundle', async () => {
    const deps = memInspectDeps({ '/bad.gmb': 'not json' });
    const render = await runBundleInspect(deps, { ref: '/bad.gmb', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string; code: string };
    expect(render.exitCode).toBe(2);
    expect(parsed.status).toBe('error');
    expect(parsed.code).toBe('artifact-malformed');
  });

  it('inherits the reader traversal guard (a packed traversal path is artifact-malformed)', async () => {
    const gmb = JSON.parse(await exportedBundleText()) as { payload: { entry: { path: string } } };
    gmb.payload.entry = { ...gmb.payload.entry, path: '../../escape.js' };
    const deps = memInspectDeps({ '/evil.gmb': JSON.stringify(gmb) });
    const render = await runBundleInspect(deps, { ref: '/evil.gmb', json: true });
    const parsed = JSON.parse(render.stdout) as { code: string };
    expect(render.exitCode).toBe(2);
    expect(parsed.code).toBe('artifact-malformed');
  });
});

describe('bundle — end to end through run()', () => {
  let dir: string;
  let projectDir: string;
  let releasePath: string;
  let trustPath: string;
  let outPath: string;

  function capture(): { io: IO; out: () => string; err: () => string } {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    return {
      io: { out: (s) => outChunks.push(s), err: (s) => errChunks.push(s) },
      out: () => outChunks.join(''),
      err: () => errChunks.join(''),
    };
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gm-bundle-'));
    projectDir = path.join(dir, 'project');
    releasePath = path.join(dir, 'release.json');
    trustPath = path.join(dir, 'trust.json');
    outPath = path.join(dir, 'acme.gmb');
    await import('node:fs/promises').then((fs) => fs.mkdir(projectDir, { recursive: true }));
    await writeFile(path.join(projectDir, 'manifest.json'), JSON.stringify(MANIFEST));
    for (const [p, content] of Object.entries(PROJECT_FILES)) await writeFile(path.join(projectDir, p), content);
    await writeFile(releasePath, JSON.stringify(await buildSignedRelease()));
    await writeFile(trustPath, trustConfig());
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exports a bundle to disk (exit 0) and it is a readable .gmb', async () => {
    const cap = capture();
    const code = await run(['bundle', 'export', projectDir, '--release', releasePath, '--output', outPath, '--json'], cap.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out()) as { status: string; bundle: string };
    expect(parsed.status).toBe('exported');
    const onDisk = JSON.parse(await readFile(outPath, 'utf8')) as { formatVersion: string };
    expect(onDisk.formatVersion).toBe('1.0');
  });

  it('inspects the exported bundle (exit 0, unverified without pins)', async () => {
    const cap = capture();
    const code = await run(['bundle', 'inspect', outPath, '--json'], cap.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out()) as { artifact: string; verdict: { status: string } };
    expect(parsed.artifact).toBe(ARTIFACT_ID);
    expect(parsed.verdict.status).toBe('unverified');
  });

  it('inspects with pinned roots and surfaces a stable verdict (exit 1)', async () => {
    const cap = capture();
    const code = await run(['bundle', 'inspect', outPath, '--trust-config', trustPath, '--json'], cap.io);
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.out()) as { verdict: { status: string; reason: string } };
    expect(parsed.verdict.status).toBe('refused');
    expect(VERIFY_BUNDLE_REASONS).toContain(parsed.verdict.reason);
  });

  it('requires --release on export', async () => {
    const cap = capture();
    const code = await run(['bundle', 'export', projectDir], cap.io);
    expect(code).not.toBe(0);
    expect(cap.err()).toContain('release');
  });

  it('bare `bundle` prints help and succeeds', async () => {
    const cap = capture();
    const code = await run(['bundle'], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toContain('export');
    expect(cap.out()).toContain('inspect');
  });
});
