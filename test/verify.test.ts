import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalize, hashBytes, verifyHash, VERIFY_RELEASE_REASONS } from '@gridmason/protocol';
import { runConformanceVectorsAsync } from '@gridmason/protocol/vectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import type { IO } from '../src/io.js';
import { formatVerdict, runVerify, type VerifyRunDeps } from '../src/verify/index.js';

/** Base64 of `n` zero bytes — a stand-in pinned key of the right encoding. */
function zeroKeyB64(n: number): string {
  return Buffer.alloc(n).toString('base64');
}

const REGISTRY = 'registry.example';
const ROOT_A = 'ROOT-A';
const ARTIFACT_ID = 'acme-chart@1.0.0';
const ISSUER = 'https://accounts.example';

/** A release document with one file; its canonical hash is computed in `beforeAll`. */
const release = {
  formatVersion: '1.0',
  artifact: ARTIFACT_ID,
  files: { 'index.js': `sha2-256:${'0'.repeat(64)}` },
} as const;

let releaseHash: string;

/** A verification-input document (`{ release, envelope, trustRoot, logEntry }`) with overridable parts. */
function makeInput(overrides: Partial<Record<'release' | 'trustRoot', unknown>> = {}): unknown {
  return {
    release: overrides.release ?? release,
    envelope: {
      formatVersion: '1.0',
      subject: { artifact: ARTIFACT_ID, releaseHash },
      publisherSig: { alg: 'ES256', cert: 'x', issuer: ISSUER, subjectClaims: {}, sig: 'AA' },
      logInclusion: { logId: 'a'.repeat(64), index: 0, proof: [] },
    },
    trustRoot:
      'trustRoot' in overrides
        ? overrides.trustRoot
        : {
            formatVersion: '1.0',
            registryId: REGISTRY,
            countersignRoots: [ROOT_A],
            issuerAllowlist: [ISSUER],
            logPublicKeys: [],
            notBefore: 0,
            notAfter: 9e15,
          },
    logEntry: {
      logId: 'a'.repeat(64),
      index: 0,
      integratedTime: 0,
      canonicalBody: '',
      inclusionProof: { treeSize: 1, rootHash: '0'.repeat(64), hashes: [] },
      checkpoint: 'origin\n1\nAAAA\n',
    },
  };
}

/** A trust-config document that pins `ROOT_A` for `REGISTRY` (the matching-pin case). */
function makeTrustConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    pins: [{ registryId: REGISTRY, root: ROOT_A, channel: 'deploy-time' }],
    publisherCARoots: [],
    countersignRoots: [],
    logPublicKey: { name: 'log', key: zeroKeyB64(32) },
    ...overrides,
  };
}

/** In-memory deps: `files` maps a URL/path to its text; anything else throws (unreadable). */
function memDeps(files: Record<string, string>): VerifyRunDeps {
  return {
    fetchText: async (url) => {
      const text = files[url];
      if (text === undefined) throw new Error('HTTP 404 Not Found');
      return text;
    },
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

describe('runVerify — blind-root refusal (SPEC §4.4)', () => {
  it('refuses to proceed with no trust config supplied', async () => {
    const render = await runVerify(memDeps({ '/art.json': JSON.stringify(makeInput()) }), {
      ref: '/art.json',
    });
    expect(render.exitCode).toBe(2);
    expect(render.stderr).toContain('no trust roots configured');
  });

  it('refuses a trust config that pins nothing', async () => {
    const files = {
      '/art.json': JSON.stringify(makeInput()),
      '/trust.json': JSON.stringify(makeTrustConfig({ pins: [] })),
    };
    const render = await runVerify(memDeps(files), { ref: '/art.json', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string; code: string };
    expect(render.exitCode).toBe(2);
    expect(parsed.status).toBe('error');
    expect(parsed.code).toBe('no-trust-config');
  });

  it('never fetches the artifact when the config is blind (fails closed first)', async () => {
    let fetched = false;
    const deps: VerifyRunDeps = {
      ...memDeps({}),
      fetchText: async () => {
        fetched = true;
        return '';
      },
    };
    await runVerify(deps, { ref: 'https://registry.example/art.json' });
    expect(fetched).toBe(false);
  });
});

describe('runVerify — verdicts delegated to verifyRelease', () => {
  it('surfaces trust-root-untrusted for an unpinned root', async () => {
    const files = {
      '/art.json': JSON.stringify(makeInput()),
      '/trust.json': JSON.stringify(makeTrustConfig({ pins: [{ registryId: REGISTRY, root: 'ROOT-Z', channel: 'deploy-time' }] })),
    };
    const render = await runVerify(memDeps(files), { ref: '/art.json', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string; reason: string };
    expect(render.exitCode).toBe(1);
    expect(parsed.status).toBe('refused');
    expect(parsed.reason).toBe('trust-root-untrusted');
  });

  it('surfaces trust-root-malformed for a non-object trust root', async () => {
    const files = {
      '/art.json': JSON.stringify(makeInput({ trustRoot: 'not-an-object' })),
      '/trust.json': JSON.stringify(makeTrustConfig()),
    };
    const render = await runVerify(memDeps(files), { ref: '/art.json', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { reason: string };
    expect(parsed.reason).toBe('trust-root-malformed');
  });

  it('reaches the signature check once the pinned root is trusted', async () => {
    const files = { '/art.json': JSON.stringify(makeInput()), '/trust.json': JSON.stringify(makeTrustConfig()) };
    const render = await runVerify(memDeps(files), { ref: '/art.json', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { reason: string };
    // The pinned root passes; the fixture's placeholder signature then fails.
    expect(parsed.reason).toBe('publisher-signature-invalid');
  });
});

describe('runVerify — tampered artifact', () => {
  it('detects a mutated file hash as content-hash-mismatch', async () => {
    const tamperedRelease = { ...release, files: { 'index.js': `sha2-256:${'f'.repeat(64)}` } };
    const files = {
      '/art.json': JSON.stringify(makeInput({ release: tamperedRelease })),
      '/trust.json': JSON.stringify(makeTrustConfig()),
    };
    const render = await runVerify(memDeps(files), { ref: '/art.json', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string; reason: string };
    expect(render.exitCode).toBe(1);
    expect(parsed.status).toBe('refused');
    expect(parsed.reason).toBe('content-hash-mismatch');
  });
});

describe('runVerify — no-tag-echo (SPEC §7)', () => {
  it('every printed refusal reason is a member of the protocol reason set', async () => {
    const scenarios: unknown[] = [
      makeInput(),
      makeInput({ trustRoot: 'not-an-object' }),
      makeInput({ release: { ...release, files: { 'index.js': `sha2-256:${'f'.repeat(64)}` } } }),
    ];
    for (const input of scenarios) {
      const files = { '/art.json': JSON.stringify(input), '/trust.json': JSON.stringify(makeTrustConfig()) };
      const render = await runVerify(memDeps(files), { ref: '/art.json', trustConfig: '/trust.json', json: true });
      const parsed = JSON.parse(render.stdout) as { reason: string };
      expect(VERIFY_RELEASE_REASONS).toContain(parsed.reason);
    }
  });

  it('never echoes the artifact id in the human verdict', async () => {
    const files = { '/art.json': JSON.stringify(makeInput()), '/trust.json': JSON.stringify(makeTrustConfig()) };
    const render = await runVerify(memDeps(files), { ref: '/art.json', trustConfig: '/trust.json' });
    expect(render.stderr).not.toContain('acme-chart');
  });
});

describe('runVerify — operational errors', () => {
  it('reports artifact-unreadable when the source cannot be fetched', async () => {
    const files = { '/trust.json': JSON.stringify(makeTrustConfig()) };
    const render = await runVerify(memDeps(files), {
      ref: 'https://registry.example/missing.json',
      trustConfig: '/trust.json',
      json: true,
    });
    const parsed = JSON.parse(render.stdout) as { code: string };
    expect(render.exitCode).toBe(2);
    expect(parsed.code).toBe('artifact-unreadable');
  });

  it('reports artifact-malformed when verification fields are missing', async () => {
    const files = { '/art.json': JSON.stringify({ release }), '/trust.json': JSON.stringify(makeTrustConfig()) };
    const render = await runVerify(memDeps(files), { ref: '/art.json', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { code: string };
    expect(parsed.code).toBe('artifact-malformed');
  });

  it('reports trust-config-invalid for malformed config JSON', async () => {
    const files = { '/art.json': JSON.stringify(makeInput()), '/trust.json': '{ not json' };
    const render = await runVerify(memDeps(files), { ref: '/art.json', trustConfig: '/trust.json', json: true });
    const parsed = JSON.parse(render.stdout) as { code: string };
    expect(parsed.code).toBe('trust-config-invalid');
  });
});

describe('runVerify — GRIDMASON_TRUST_CONFIG fallback', () => {
  it('resolves the trust config from the env var', async () => {
    const files = { '/art.json': JSON.stringify(makeInput()), '/env-trust.json': JSON.stringify(makeTrustConfig()) };
    const deps: VerifyRunDeps = {
      ...memDeps(files),
      env: (name) => (name === 'GRIDMASON_TRUST_CONFIG' ? '/env-trust.json' : undefined),
    };
    const render = await runVerify(deps, { ref: '/art.json', json: true });
    const parsed = JSON.parse(render.stdout) as { status: string };
    // A config was found, so the run reaches a verdict rather than a blind-root error.
    expect(parsed.status).toBe('refused');
  });
});

describe('formatVerdict — verified rendering (the green path)', () => {
  it('renders a verified outcome as exit 0 with issuer + file count', () => {
    const render = formatVerdict(
      {
        kind: 'verified',
        artifact: ARTIFACT_ID,
        issuer: ISSUER,
        subject: { artifact: ARTIFACT_ID, releaseHash: `sha2-256:${'0'.repeat(64)}` },
        fileCount: 3,
      },
      { json: true },
    );
    expect(render.exitCode).toBe(0);
    const parsed = JSON.parse(render.stdout) as { status: string; issuer: string; fileCount: number };
    expect(parsed.status).toBe('verified');
    expect(parsed.issuer).toBe(ISSUER);
    expect(parsed.fileCount).toBe(3);
  });
});

describe('protocol conformance vectors — through the CLI content-hash surface', () => {
  it('the hash primitives verify delegates to pass the shipped vector corpus', async () => {
    const report = await runConformanceVectorsAsync({ hashBytes, verifyHash });
    expect(report.ok).toBe(true);
    expect(report.total).toBeGreaterThan(0);
  });
});

describe('verify command — end to end through run()', () => {
  let dir: string;
  let artifactPath: string;
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
    dir = await mkdtemp(path.join(tmpdir(), 'gm-verify-'));
    artifactPath = path.join(dir, 'art.json');
    trustPath = path.join(dir, 'trust.json');
    await writeFile(artifactPath, JSON.stringify(makeInput()));
    await writeFile(trustPath, JSON.stringify(makeTrustConfig()));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exits 2 with no trust config (blind-root refusal)', async () => {
    const cap = capture();
    const code = await run(['verify', artifactPath], cap.io);
    expect(code).toBe(2);
    expect(cap.err()).toContain('no trust roots configured');
  });

  it('exits 1 and prints a stable refusal verdict with a pinned root', async () => {
    const cap = capture();
    const code = await run(['verify', artifactPath, '--trust-config', trustPath, '--json'], cap.io);
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.out()) as { command: string; status: string; reason: string };
    expect(parsed.command).toBe('verify');
    expect(parsed.status).toBe('refused');
    expect(VERIFY_RELEASE_REASONS).toContain(parsed.reason);
  });

  it('still reports --offline as deferred (not implemented)', async () => {
    const cap = capture();
    const code = await run(['verify', artifactPath, '--offline', '--json'], cap.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out()) as { command: string; status: string };
    expect(parsed.command).toBe('verify');
    expect(parsed.status).toBe('not-implemented');
  });
});
