import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonicalize,
  evaluateTrustRoot,
  hashBytes,
  verifyHash,
  verifyLogConsistency,
  VERIFY_BUNDLE_REASONS,
  type GmbBundle,
  type MultihashString,
} from '@gridmason/protocol';
import { runConformanceVectorsAsync } from '@gridmason/protocol/vectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import type { IO } from '../src/io.js';
import { enforcePackedFiles, runVerifyOffline, type VerifyOfflineDeps } from '../src/verify/index.js';

function zeroKeyB64(n: number): string {
  return Buffer.alloc(n).toString('base64');
}
function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

const REGISTRY = 'registry.example';
const ROOT_A = 'ROOT-A';
const ARTIFACT_ID = 'acme-chart@1.0.0';
const ISSUER = 'https://accounts.example';

const release = {
  formatVersion: '1.0',
  artifact: ARTIFACT_ID,
  files: { 'index.js': `sha2-256:${'0'.repeat(64)}` },
} as const;

let releaseHash: string;

/** Build a `.gmb` payload; overridable release lets a test tamper the archive. */
function makePayload(overrides: { release?: unknown } = {}): unknown {
  return {
    manifest: { id: 'acme-chart', kind: 'widget' },
    release: overrides.release ?? release,
    envelope: {
      formatVersion: '1.0',
      subject: { artifact: ARTIFACT_ID, releaseHash },
      publisherSig: { alg: 'ES256', cert: 'x', issuer: ISSUER, subjectClaims: {}, sig: 'AA' },
      logInclusion: { logId: 'a'.repeat(64), index: 0, proof: [] },
    },
    logEntry: {
      logId: 'a'.repeat(64),
      index: 0,
      integratedTime: 0,
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
    entry: { path: 'index.js', bytes: b64('console.log(1)') },
    chunks: [],
    schemas: [],
    docs: [],
  };
}

/** Seal a payload into a well-formed bundle (contentHash over the canonical payload). */
async function sealBundle(payload: unknown, hashOverride?: string): Promise<unknown> {
  const contentHash = hashOverride ?? (await hashBytes(canonicalize(payload)));
  return { formatVersion: '1.0', producedBy: REGISTRY, contentHash, payload };
}

function makeTrustConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    pins: [{ registryId: REGISTRY, root: ROOT_A, channel: 'deploy-time' }],
    publisherCARoots: [],
    countersignRoots: [],
    logPublicKey: { name: 'log', key: zeroKeyB64(32) },
    ...overrides,
  };
}

function memDeps(files: Record<string, string>): VerifyOfflineDeps {
  return {
    readFile: async (p) => {
      const text = files[p];
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    env: () => undefined,
    now: () => 1_000_000,
  };
}

beforeAll(async () => {
  releaseHash = await hashBytes(canonicalize(release));
});

describe('runVerifyOffline — blind-root refusal (SPEC §4.4)', () => {
  it('refuses with no trust config, before reading the bundle', async () => {
    let read = false;
    const deps: VerifyOfflineDeps = {
      readFile: async () => {
        read = true;
        return '';
      },
      env: () => undefined,
      now: () => 1_000_000,
    };
    const render = await runVerifyOffline(deps, { ref: '/pkg.gmb', json: true });
    const parsed = JSON.parse(render.stdout) as { code: string };
    expect(render.exitCode).toBe(2);
    expect(parsed.code).toBe('no-trust-config');
    expect(read).toBe(false);
  });
});

describe('runVerifyOffline — verdicts delegated to verifyOfflineBundle', () => {
  it('reaches the signature chain for a well-sealed, pinned bundle', async () => {
    const files = {
      '/pkg.gmb': JSON.stringify(await sealBundle(makePayload())),
      '/trust.json': JSON.stringify(makeTrustConfig()),
    };
    const render = await runVerifyOffline(memDeps(files), { ref: '/pkg.gmb', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string; reason: string };
    expect(render.exitCode).toBe(1);
    expect(parsed.status).toBe('refused');
    expect(parsed.reason).toBe('publisher-signature-invalid');
  });

  it('detects a tampered archive as bundle-hash-tampered', async () => {
    // Seal the honest payload, then swap in a tampered release without resealing.
    const honest = (await sealBundle(makePayload())) as { contentHash: string };
    const tampered = { ...honest, payload: makePayload({ release: { ...release, files: { 'index.js': `sha2-256:${'f'.repeat(64)}` } } }) };
    const files = { '/pkg.gmb': JSON.stringify(tampered), '/trust.json': JSON.stringify(makeTrustConfig()) };
    const render = await runVerifyOffline(memDeps(files), { ref: '/pkg.gmb', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { reason: string };
    expect(parsed.reason).toBe('bundle-hash-tampered');
  });

  it('reports bundle-malformed for a malformed content-hash string', async () => {
    const files = {
      '/pkg.gmb': JSON.stringify(await sealBundle(makePayload(), 'not-a-multihash')),
      '/trust.json': JSON.stringify(makeTrustConfig()),
    };
    const render = await runVerifyOffline(memDeps(files), { ref: '/pkg.gmb', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { reason: string };
    expect(parsed.reason).toBe('bundle-malformed');
  });

  it('refuses an unpinned embedded root with trust-root-untrusted', async () => {
    const files = {
      '/pkg.gmb': JSON.stringify(await sealBundle(makePayload())),
      '/trust.json': JSON.stringify(makeTrustConfig({ pins: [{ registryId: REGISTRY, root: 'ROOT-Z', channel: 'deploy-time' }] })),
    };
    const render = await runVerifyOffline(memDeps(files), { ref: '/pkg.gmb', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { reason: string };
    expect(parsed.reason).toBe('trust-root-untrusted');
  });
});

describe('runVerifyOffline — operational errors', () => {
  it('reports artifact-unreadable when the .gmb is missing', async () => {
    const files = { '/trust.json': JSON.stringify(makeTrustConfig()) };
    const render = await runVerifyOffline(memDeps(files), { ref: '/missing.gmb', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { code: string };
    expect(render.exitCode).toBe(2);
    expect(parsed.code).toBe('artifact-unreadable');
  });

  it('reports artifact-malformed for a non-JSON bundle', async () => {
    const files = { '/pkg.gmb': 'not json at all', '/trust.json': JSON.stringify(makeTrustConfig()) };
    const render = await runVerifyOffline(memDeps(files), { ref: '/pkg.gmb', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { code: string };
    expect(parsed.code).toBe('artifact-malformed');
  });

  it('reports artifact-malformed for a non-string contentHash (would otherwise throw)', async () => {
    const bundle = { formatVersion: '1.0', producedBy: REGISTRY, contentHash: 123, payload: makePayload() };
    const files = { '/pkg.gmb': JSON.stringify(bundle), '/trust.json': JSON.stringify(makeTrustConfig()) };
    const render = await runVerifyOffline(memDeps(files), { ref: '/pkg.gmb', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { code: string };
    expect(parsed.code).toBe('artifact-malformed');
  });
});

describe('runVerifyOffline — no-tag-echo (SPEC §7)', () => {
  it('every refusal reason is a member of the bundle reason set', async () => {
    const bundles: unknown[] = [
      await sealBundle(makePayload()),
      await sealBundle(makePayload(), 'not-a-multihash'),
    ];
    for (const bundle of bundles) {
      const files = { '/pkg.gmb': JSON.stringify(bundle), '/trust.json': JSON.stringify(makeTrustConfig()) };
      const render = await runVerifyOffline(memDeps(files), { ref: '/pkg.gmb', trustConfig: '/trust.json', json: true });
      const parsed = JSON.parse(render.stdout) as { reason: string };
      expect(VERIFY_BUNDLE_REASONS).toContain(parsed.reason);
    }
  });

  it('never echoes the artifact id in the human verdict', async () => {
    const files = { '/pkg.gmb': JSON.stringify(await sealBundle(makePayload())), '/trust.json': JSON.stringify(makeTrustConfig()) };
    const render = await runVerifyOffline(memDeps(files), { ref: '/pkg.gmb', trustConfig: '/trust.json' });
    expect(render.stderr).not.toContain('acme-chart');
  });
});

describe('enforcePackedFiles — verifyChunk over the packed bytes', () => {
  /** A bundle whose packed files carry `packed[i].content` (base64), independent of the hash map. */
  function bundleWithPacked(packed: { path: string; content: string }[]): GmbBundle {
    const [entry, ...rest] = packed;
    return {
      formatVersion: '1.0',
      producedBy: REGISTRY,
      contentHash: `sha2-256:${'0'.repeat(64)}`,
      payload: {
        manifest: { id: 'x', kind: 'widget' },
        release,
        envelope: {} as never,
        logEntry: {} as never,
        trustRoot: {} as never,
        entry: { path: entry?.path ?? '', bytes: b64(entry?.content ?? '') },
        chunks: rest.map((f) => ({ path: f.path, bytes: b64(f.content) })),
        schemas: [],
        docs: [],
      },
    } as unknown as GmbBundle;
  }

  /** A verified `url → hash` map over the given file contents. */
  async function hashMap(files: { path: string; content: string }[]): Promise<Map<string, MultihashString>> {
    const map = new Map<string, MultihashString>();
    for (const f of files) {
      map.set(f.path, await hashBytes(new Uint8Array(Buffer.from(f.content, 'utf8'))));
    }
    return map;
  }

  it('passes when every listed file packs bytes that match its verified hash', async () => {
    const files = [
      { path: 'index.js', content: 'export const a = 1;' },
      { path: 'chunk.js', content: 'export const b = 2;' },
    ];
    expect(await enforcePackedFiles(bundleWithPacked(files), await hashMap(files))).toEqual({ ok: true });
  });

  it('fails when a packed file’s bytes do not match its verified hash', async () => {
    // Hash map computed over 'original', but the bundle packs 'tampered'.
    const urlHashes = await hashMap([{ path: 'index.js', content: 'original' }]);
    const bundle = bundleWithPacked([{ path: 'index.js', content: 'tampered' }]);
    expect(await enforcePackedFiles(bundle, urlHashes)).toEqual({ ok: false, path: 'index.js' });
  });

  it('fails when a verified path is not packed in the bundle', async () => {
    const bundle = bundleWithPacked([{ path: 'index.js', content: 'x' }]);
    const urlHashes = new Map<string, MultihashString>([['missing.js', `sha2-256:${'a'.repeat(64)}`]]);
    expect(await enforcePackedFiles(bundle, urlHashes)).toEqual({ ok: false, path: 'missing.js' });
  });
});

describe('protocol conformance vectors — through the CLI offline verify surfaces', () => {
  it('the trust-root, signature, log, and hash leaves the bundle chain composes pass the corpus', async () => {
    const report = await runConformanceVectorsAsync({
      hashBytes,
      verifyHash,
      evaluateTrustRoot,
      verifyLogConsistency,
    });
    expect(report.ok).toBe(true);
    expect(report.total).toBeGreaterThan(0);
  });
});

describe('verify --offline — end to end through run()', () => {
  let dir: string;
  let bundlePath: string;
  let trustPath: string;

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
    dir = await mkdtemp(path.join(tmpdir(), 'gm-verify-offline-'));
    bundlePath = path.join(dir, 'pkg.gmb');
    trustPath = path.join(dir, 'trust.json');
    await writeFile(bundlePath, JSON.stringify(await sealBundle(makePayload())));
    await writeFile(trustPath, JSON.stringify(makeTrustConfig()));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exits 2 with no trust config (blind-root refusal)', async () => {
    const cap = capture();
    const code = await run(['verify', bundlePath, '--offline'], cap.io);
    expect(code).toBe(2);
    expect(cap.err()).toContain('no trust roots configured');
  });

  it('exits 1 and prints a stable bundle verdict with a pinned root', async () => {
    const cap = capture();
    const code = await run(['verify', bundlePath, '--offline', '--trust-config', trustPath, '--json'], cap.io);
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.out()) as { command: string; status: string; reason: string };
    expect(parsed.command).toBe('verify');
    expect(parsed.status).toBe('refused');
    expect(VERIFY_BUNDLE_REASONS).toContain(parsed.reason);
  });
});
