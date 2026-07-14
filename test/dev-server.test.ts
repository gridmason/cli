/**
 * Integration test for `gridmason dev` (#9, FR-4/FR-5). Drives a real HTTP
 * server over a freshly-scaffolded widget project and covers the issue's whole
 * acceptance list: source edit → hot reload; fixture edit → data updates;
 * manifest edit → live re-validation; `--context` selects a named preset; proxy
 * mode forwards SDK calls while a denied capability stays denied; and the server
 * serves no data of its own.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planScaffold } from '../src/init/files.js';
import { writeProject } from '../src/init/scaffold.js';
import { createWatcher } from '../src/dev/watch.js';
import { resolveProject } from '../src/dev/project.js';
import { type DevServer, type DevServerOptions, createDevServer } from '../src/dev/server.js';

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url));

let dir: string;
let root: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gm-dev-srv-'));
  const scaffold = planScaffold({ name: 'Sales Chart', publisher: 'acme', kind: 'widget', framework: 'vanilla' });
  root = path.join(dir, scaffold.directory);
  await writeProject(root, scaffold.files);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

/** Start a dev server on an OS-assigned port, registered for cleanup. */
async function start(overrides: Partial<DevServerOptions> = {}): Promise<DevServer> {
  const server = await createDevServer({ project: resolveProject(root), port: 0, cliRoot: CLI_ROOT, ...overrides });
  cleanups.push(() => server.close());
  return server;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' });
  return res.json();
}

describe('serving the entry + harness', () => {
  it('serves the widget entry module for the dashboard sideload', async () => {
    const server = await start();
    const res = await fetch(`${server.url}/src/entry.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.text();
    expect(body).toContain("customElements.define('acme-sales-chart'");
  });

  it('serves a fixture harness page referencing the tag and the SDK import map', async () => {
    const server = await start();
    const html = await (await fetch(`${server.url}/`)).text();
    expect(html).toContain('acme-sales-chart');
    expect(html).toContain('@gridmason/sdk/fixture');
    expect(html).toContain('/@dev/events');
  });

  it('refuses to escape the project root (path traversal)', async () => {
    const server = await start();
    // Encoded slashes keep the client from normalizing the `..` away, so the
    // traversal actually reaches the server, where safeJoin rejects it.
    const encoded = await fetch(`${server.url}/x%2f%2e%2e%2f%2e%2e%2fpackage.json`);
    expect(encoded.status).toBe(403);
  });
});

describe('manifest edit → live re-validation', () => {
  it('reports the manifest valid, then invalid after an edit — read fresh each time', async () => {
    const server = await start();
    expect(await getJson(`${server.url}/@dev/manifest`)).toMatchObject({ valid: true, tag: 'acme-sales-chart' });

    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ tag: 'Bad Tag', publisher: 'acme' }), 'utf8');

    const after = (await getJson(`${server.url}/@dev/manifest`)) as { valid: boolean; violations: string[] };
    expect(after.valid).toBe(false);
    expect(after.violations.join(' ')).toMatch(/Bad Tag/);
  });
});

describe('fixture edit → data updates', () => {
  it('serves the fixture fresh from disk, reflecting an edit immediately', async () => {
    const server = await start();
    const before = (await getJson(`${server.url}/@dev/fixtures`)) as { records?: { read?: Array<{ fields: Record<string, unknown> }> } };
    expect(before.records?.read?.[0]?.fields).toMatchObject({ name: 'Sample example' });

    await writeFile(
      path.join(root, 'fixtures/default.json'),
      JSON.stringify({ records: { read: [{ ref: { recordType: 'example' }, fields: { name: 'Edited' } }] } }),
      'utf8',
    );
    const after = (await getJson(`${server.url}/@dev/fixtures`)) as { records?: { read?: Array<{ fields: Record<string, unknown> }> } };
    expect(after.records?.read?.[0]?.fields).toEqual({ name: 'Edited' });
  });
});

describe('--context selects a named preset', () => {
  it('serves default.json context with no flag, and the named preset with one', async () => {
    const plain = await start();
    expect(await getJson(`${plain.url}/@dev/context`)).toEqual({
      source: 'default',
      context: { primary: { recordType: 'example', id: 'example-1' } },
    });

    const withContext = await start({ contextName: 'example-2' });
    expect(await getJson(`${withContext.url}/@dev/context`)).toEqual({
      source: 'preset',
      name: 'example-2',
      context: { primary: { recordType: 'example', id: 'example-2' } },
    });
  });

  it('404s a context preset that does not exist', async () => {
    const server = await start({ contextName: 'ghost' });
    const res = await fetch(`${server.url}/@dev/context`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/ghost/);
  });
});

describe('hot reload over SSE', () => {
  it('broadcasts a reload event and bumps the generation on a source change', async () => {
    const server = await start();
    const sse = await openSse(`${server.url}/@dev/events`);
    cleanups.push(async () => sse.close());

    const firstGen = server.generation();
    server.reload('source');
    server.reload('fixtures');
    await sse.waitFor(2);

    expect(sse.events[0]).toEqual({ category: 'source', generation: firstGen + 1 });
    // A data-only change does not bump the generation (no module re-import needed).
    expect(sse.events[1]).toEqual({ category: 'fixtures', generation: firstGen + 1 });
  });

  it('fires the watcher with the right category on a real source edit', async () => {
    const seen: string[] = [];
    let resolveFirst!: () => void;
    const first = new Promise<void>((r) => (resolveFirst = r));
    const watcher = createWatcher(resolveProject(root), (category) => {
      seen.push(category);
      resolveFirst();
    });
    cleanups.push(() => watcher.close());

    // chokidar needs a moment to be ready before it reports edits.
    await delay(300);
    await writeFile(path.join(root, 'src/entry.js'), '// edited\n', 'utf8');
    await Promise.race([first, delay(4000)]);
    expect(seen).toContain('source');
  });
});

describe('--proxy forwards SDK calls with capability enforcement', () => {
  it('forwards a declared call to the target but denies an undeclared one without hitting it', async () => {
    const hits: Array<{ method: string; args: unknown[] }> = [];
    const target = await startTarget((call) => {
      hits.push(call);
      return { ok: true, value: { echoed: call.method } };
    });
    cleanups.push(() => target.close());

    const server = await start({ proxyUrl: target.url });

    const allowed = await postJson(`${server.url}/@dev/sdk`, {
      method: 'records.read',
      args: [{ recordType: 'example', id: 'e1' }],
    });
    expect(allowed).toEqual({ status: 'forwarded', value: { echoed: 'records.read' } });
    expect(hits).toHaveLength(1);

    const denied = await postJson(`${server.url}/@dev/sdk`, {
      method: 'records.read',
      args: [{ recordType: 'secret', id: 's1' }],
    });
    expect(denied).toEqual({ status: 'denied', capability: { api: 'records.read', scope: 'recordType:secret' } });
    expect(hits).toHaveLength(1); // the denied call never reached the target
  });
});

describe('the server serves no data of its own', () => {
  it('answers no SDK calls in fixture mode (data must come from a fixture in the browser)', async () => {
    const server = await start();
    const res = await fetch(`${server.url}/@dev/sdk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'records.read', args: [{ recordType: 'example', id: 'e1' }] }),
    });
    expect(res.status).toBe(409);
  });

  it('serves exactly the on-disk fixture, adding nothing', async () => {
    await writeFile(path.join(root, 'fixtures/default.json'), JSON.stringify({}), 'utf8');
    const server = await start();
    expect(await getJson(`${server.url}/@dev/fixtures`)).toEqual({});
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Read an SSE stream, parsing `reload` frames into an array with a `waitFor(n)` gate. */
async function openSse(url: string): Promise<{
  events: Array<{ category: string; generation: number }>;
  waitFor: (n: number) => Promise<void>;
  close: () => void;
}> {
  const controller = new AbortController();
  const events: Array<{ category: string; generation: number }> = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const notify = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (events.length >= waiters[i]!.n) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  };

  const res = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let connected!: () => void;
  const ready = new Promise<void>((r) => (connected = r));

  void (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        connected();
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
          if (event === 'reload') {
            events.push(JSON.parse(data));
            notify();
          }
        }
      }
    } catch {
      // aborted on close
    }
  })();

  await ready;
  return {
    events,
    waitFor: (n) => (events.length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve }))),
    close: () => controller.abort(),
  };
}
