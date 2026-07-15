/**
 * End-to-end: the publish leg of the author loop (SPEC §9, Phase B) — scaffold →
 * lint-gate → keyless sign → **upload over real HTTP** → poll → reviewed state.
 *
 * The registry is a **contract-faithful fake Publish API server** running on
 * localhost (`test/helpers/fake-registry.ts`): it runs the shared `src/checks` as
 * its automated review and content-addresses parts with the protocol hashing, so
 * this exercises the real transport (`fetchTransport` → `fetch` → a real socket),
 * the real artifact assembly, the real lint gate, and the real poll loop. Standing
 * up the actual registry service (Postgres + object store + OIDC verifier +
 * reviewer roster + countersign key) is impractical here and, for M-B1, it exposes
 * no publisher-facing status/appeal surface — so the fake stands in for it. This
 * substitution is called out prominently in the PR body.
 *
 * The keyless signer is the offline `ephemeralSigner` (no Sigstore/Fulcio network);
 * the Fulcio-cert `sigstoreSigner` is the production default, exercised opt-in
 * against a live instance (mirroring `login`'s live-staging leg).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IO } from '../../src/io.js';
import { runInit } from '../../src/init/index.js';
import { assembleArtifact } from '../../src/publish/artifact.js';
import { ephemeralSigner } from '../../src/publish/signing.js';
import { fetchTransport } from '../../src/publish/transport.js';
import { runPublish, type PublishDeps } from '../../src/publish/run.js';
import { runAppeal } from '../../src/publish/appeal.js';
import type { AcquiredIdentity } from '../../src/publish/identity.js';
import { FakeRegistry, startFakeRegistry } from '../helpers/fake-registry.js';

const IDENTITY: AcquiredIdentity = {
  token: 'e2e.oidc.token',
  identity: { issuer: 'https://issuer.example', subject: 'dev@acme.example', subjectClaims: { email: 'dev@acme.example' }, expiresAt: null },
  provider: { getToken: () => Promise.resolve('e2e.oidc.token') },
};

function capture(): { io: IO; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out: () => out.join(''), err: () => err.join('') };
}

/** Production-shaped deps: real transport + real fetch to the localhost fake, ephemeral offline signer. */
function deps(): PublishDeps {
  return {
    assemble: (root) => assembleArtifact(root),
    acquireIdentity: () => Promise.resolve(IDENTITY),
    makeSigner: () => ephemeralSigner(),
    client: { transport: fetchTransport() },
    sleep: () => Promise.resolve(),
  };
}

let tmp: string;
let server: Awaited<ReturnType<typeof startFakeRegistry>>;
let fake: FakeRegistry;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'gm-publish-e2e-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  fake = new FakeRegistry({ approveAfterPolls: 2 });
  server = await startFakeRegistry(fake);
});
afterEach(async () => {
  await server.close();
});

async function scaffold(name: string, publisher = 'acme'): Promise<{ dir: string; tag: string }> {
  const cap = capture();
  const code = await runInit({ name, publisher, kind: 'widget', framework: 'vanilla', json: true, cwd: tmp }, cap.io, { isTTY: false });
  expect(code, cap.err()).toBe(0);
  const { directory } = JSON.parse(cap.out()) as { directory: string };
  const dir = path.join(tmp, directory);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { tag: string };
  return { dir, tag: manifest.tag };
}

describe('publish e2e against a local (fake) registry over HTTP', () => {
  it('drives a scaffolded widget to the reviewed/published state', async () => {
    const { dir } = await scaffold('e2e-happy');
    const cap = capture();
    const code = await runPublish(deps(), { path: dir, registry: server.url, json: true, poll: { attempts: 6, intervalMs: 0 } }, cap.io);
    expect(code, cap.err()).toBe(0);
    const report = JSON.parse(cap.out()) as { status: string; state: string; id: string };
    expect(report.status).toBe('published');
    expect(report.state).toBe('approved');
    expect(fake.uploadAttempts).toBe(1);
  });

  it('refuses a lint-failing widget before any upload', async () => {
    const { dir } = await scaffold('e2e-refuse');
    const entry = path.join(dir, 'src', 'entry.js');
    await writeFile(entry, `${await readFile(entry, 'utf8')}\nglobalThis.fetch('https://evil.example');\n`, 'utf8');

    const cap = capture();
    const code = await runPublish(deps(), { path: dir, registry: server.url, json: true }, cap.io);
    expect(code).toBe(1);
    expect((JSON.parse(cap.out()) as { status: string }).status).toBe('refused');
    expect(fake.uploadAttempts).toBe(0);
  });

  it('rejects, prints mapped findings, then routes an appeal to a second review', async () => {
    const { dir, tag } = await scaffold('e2e-appeal');
    // Reconfigure the running fake to reject this tag with findings.
    fake = new FakeRegistry({ rejectTags: { [tag]: [{ checkId: 'manual', detail: 'first reviewer rejected by hand' }] } });
    await server.close();
    server = await startFakeRegistry(fake);

    const pub = capture();
    const rejectCode = await runPublish(deps(), { path: dir, registry: server.url, json: true, poll: { attempts: 3, intervalMs: 0 } }, pub.io);
    expect(rejectCode).toBe(1);
    const rejected = JSON.parse(pub.out()) as { status: string; id: string };
    expect(rejected.status).toBe('rejected');

    const cap = capture();
    const appealCode = await runAppeal(
      { acquireIdentity: () => Promise.resolve(IDENTITY), client: { transport: fetchTransport() } },
      { artifact: rejected.id, registry: server.url, json: true },
      cap.io,
    );
    expect(appealCode, cap.err()).toBe(0);
    expect((JSON.parse(cap.out()) as { status: string }).status).toBe('appealed');
  });
});
