/**
 * Tests for the SDK inspector (#10, FR-6, SPEC §4). The core case is the
 * acceptance one: a widget makes one **declared** call whose fixture is missing
 * (→ `default-empty`, an uncovered data path) and one **undeclared** call (→ a
 * `violation` the review would flag), and the inspector session surfaces both.
 * It is driven through the real fixture SDK exactly as the browser harness does —
 * the fixture tags each call on its recorder, and each tag is POSTed to
 * `/@dev/inspect` — so the server enrichment is exercised end to end without a
 * browser. The rest covers the enrichment unit, the live SSE `inspect` frame, the
 * per-mount reset, and the `--proxy` recording path.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixtureSDK, getFixtureControls } from '@gridmason/sdk/fixture';
import { planScaffold } from '../src/init/files.js';
import { writeProject } from '../src/init/scaffold.js';
import { resolveProject } from '../src/dev/project.js';
import { type DevServer, type DevServerOptions, createDevServer } from '../src/dev/server.js';
import {
  type ObservationOutcome,
  type RawObservation,
  type SdkObservation,
  enrichObservation,
} from '../src/dev/inspector.js';

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url));

let dir: string;
let root: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gm-dev-inspect-'));
  // The scaffold's manifest declares exactly `records.read:recordType:example`.
  const scaffold = planScaffold({ name: 'Sales Chart', publisher: 'acme', kind: 'widget', framework: 'vanilla' });
  root = path.join(dir, scaffold.directory);
  await writeProject(root, scaffold.files);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

async function start(overrides: Partial<DevServerOptions> = {}): Promise<DevServer> {
  const server = await createDevServer({ project: resolveProject(root), port: 0, cliRoot: CLI_ROOT, ...overrides });
  cleanups.push(() => server.close());
  return server;
}

interface InspectSession {
  declared: string[];
  calls: SdkObservation[];
}

async function getSession(server: DevServer): Promise<InspectSession> {
  return (await (await fetch(`${server.url}/@dev/inspect`, { cache: 'no-store' })).json()) as InspectSession;
}

/** Report every gated call a fixture SDK recorded to the server, exactly as the harness does. */
async function reportRecorder(server: DevServer, sdk: ReturnType<typeof createFixtureSDK>): Promise<void> {
  for (const call of getFixtureControls(sdk).recorder.calls) {
    const outcome = (call.meta as { outcome?: ObservationOutcome } | undefined)?.outcome;
    if (outcome === undefined) continue; // ungated call — no capability, not reported
    await fetch(`${server.url}/@dev/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: call.method, outcome, arg: call.args[0] } satisfies RawObservation),
    });
  }
}

describe('declared vs actual calls: violation + default-empty (the acceptance case)', () => {
  it('flags an undeclared call as a violation and a fixture-less declared call as default-empty', async () => {
    const server = await start();

    // A widget exercised against the manifest's caps but with NO fixture data, so a
    // declared read has nothing to hit. `secret` is not declared, so it is denied.
    const sdk = createFixtureSDK({}, { capabilities: ['records.read:recordType:example'], instanceId: 'dev-1' });
    await sdk.records.read({ recordType: 'example', id: 'e1' });
    await sdk.records.read({ recordType: 'secret', id: 's1' }).catch(() => undefined);
    sdk.nav.toast({ message: 'hi' }); // ungated — must not appear in the inspector

    await reportRecorder(server, sdk);

    const session = await getSession(server);
    expect(session.declared).toEqual(['records.read:recordType:example']);
    expect(session.calls).toHaveLength(2);

    expect(session.calls[0]).toMatchObject({
      method: 'records.read',
      capability: 'records.read:recordType:example',
      outcome: 'default-empty',
      declared: true,
      violation: false,
      grantedBy: 'records.read:recordType:example',
    });
    expect(session.calls[1]).toMatchObject({
      method: 'records.read',
      capability: 'records.read:recordType:secret',
      outcome: 'denied',
      declared: false,
      violation: true,
      grantedBy: null,
    });
  });

  it('marks a declared capability used only once a granted call exercises it', async () => {
    const server = await start();
    let session = await getSession(server);
    expect(session.declared).toEqual(['records.read:recordType:example']);
    expect(session.calls).toEqual([]);

    // A fixture-hit read exercises the declared capability.
    const sdk = createFixtureSDK(
      { records: { read: [{ ref: { recordType: 'example' }, fields: { name: 'X' } }] } },
      { capabilities: ['records.read:recordType:example'], instanceId: 'dev-1' },
    );
    await sdk.records.read({ recordType: 'example', id: 'e1' });
    await reportRecorder(server, sdk);

    session = await getSession(server);
    expect(session.calls[0]).toMatchObject({ outcome: 'fixture-hit', grantedBy: 'records.read:recordType:example' });
  });
});

describe('enrichObservation', () => {
  const declared = [{ api: 'records.read' as const, scope: 'recordType:example' }];

  it('attributes a granted gated call to the declaring capability', () => {
    const raw: RawObservation = { method: 'records.read', outcome: 'fixture-hit', arg: { recordType: 'example', id: 'e1' } };
    expect(enrichObservation(raw, declared, 0)).toEqual({
      seq: 0,
      method: 'records.read',
      api: 'records.read',
      capability: 'records.read:recordType:example',
      outcome: 'fixture-hit',
      declared: true,
      violation: false,
      grantedBy: 'records.read:recordType:example',
    });
  });

  it('marks an undeclared gated call a violation', () => {
    const raw: RawObservation = { method: 'net.fetch', outcome: 'denied', arg: { host: 'evil.example', path: '/' } };
    expect(enrichObservation(raw, declared, 3)).toMatchObject({
      api: 'net',
      capability: 'net:evil.example',
      declared: false,
      violation: true,
      grantedBy: null,
    });
  });

  it('never flags an ungated call (no capability to declare)', () => {
    const raw: RawObservation = { method: 'nav.toast', outcome: 'allowed', arg: { message: 'hi' } };
    expect(enrichObservation(raw, [], 0)).toMatchObject({ api: null, capability: null, declared: true, violation: false });
  });
});

describe('the inspector page + live channel', () => {
  it('serves a self-contained inspector page naming the tag', async () => {
    const server = await start();
    const html = await (await fetch(`${server.url}/@dev/inspector`)).text();
    expect(html).toContain('SDK inspector');
    expect(html).toContain('acme-sales-chart');
    expect(html).toContain('/@dev/inspect');
    expect(html).toContain('/@dev/events'); // follows the shared SSE channel
  });

  it('broadcasts each observed call as an `inspect` SSE frame', async () => {
    const server = await start();
    const sse = await openSse(`${server.url}/@dev/events`);
    cleanups.push(async () => sse.close());

    await fetch(`${server.url}/@dev/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'records.read', outcome: 'default-empty', arg: { recordType: 'example', id: 'e1' } }),
    });
    await sse.waitForInspect(1);

    expect(sse.inspects[0]).toMatchObject({ method: 'records.read', outcome: 'default-empty', violation: false });
  });

  it('clears the session on a reload — a re-mount starts fresh', async () => {
    const server = await start();
    await fetch(`${server.url}/@dev/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'records.read', outcome: 'default-empty', arg: { recordType: 'example', id: 'e1' } }),
    });
    expect((await getSession(server)).calls).toHaveLength(1);

    server.reload('source');
    expect((await getSession(server)).calls).toEqual([]);
  });
});

describe('--proxy mode records calls server-side', () => {
  it('records a forwarded call as proxied and a denied one as a violation', async () => {
    const target = await startTarget(() => ({ ok: true, value: {} }));
    cleanups.push(() => target.close());
    const server = await start({ proxyUrl: target.url });

    await postJson(`${server.url}/@dev/sdk`, { method: 'records.read', args: [{ recordType: 'example', id: 'e1' }] });
    await postJson(`${server.url}/@dev/sdk`, { method: 'records.read', args: [{ recordType: 'secret', id: 's1' }] });

    const session = await getSession(server);
    expect(session.calls).toHaveLength(2);
    expect(session.calls[0]).toMatchObject({ outcome: 'proxied', declared: true, violation: false });
    expect(session.calls[1]).toMatchObject({ outcome: 'denied', declared: false, violation: true });
  });
});

// --- helpers ---

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** A fake `--proxy` target speaking the dev SDK-forward contract. */
async function startTarget(
  handler: (call: { method: string; args: unknown[] }) => unknown,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/__gridmason_dev__/sdk') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; args: unknown[] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handler(call)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Read an SSE stream, collecting `inspect` frames with a `waitForInspect(n)` gate. */
async function openSse(url: string): Promise<{
  inspects: SdkObservation[];
  waitForInspect: (n: number) => Promise<void>;
  close: () => void;
}> {
  const controller = new AbortController();
  const inspects: SdkObservation[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const notify = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (inspects.length >= waiters[i]!.n) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  };

  const res = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  void (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (event === 'inspect') {
            inspects.push(JSON.parse(data) as SdkObservation);
            notify();
          }
        }
      }
    } catch {
      // aborted on close
    }
  })();

  return {
    inspects,
    waitForInspect: (n) =>
      inspects.length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve })),
    close: () => controller.abort(),
  };
}
