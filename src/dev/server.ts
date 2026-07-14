/**
 * The `dev` HTTP server (SPEC §4, FR-4/FR-5). It is a **conduit, not a backend**:
 * it serves the widget's `entry` module (and its sibling source) for the
 * dashboard's `dev` sideload, exposes the project's live manifest / capabilities
 * / fixtures / context as read-only JSON for the fixture harness, streams
 * hot-reload notifications over SSE, and — only under `--proxy` — enforces the
 * declared capabilities and forwards allowed SDK calls to a real host. It
 * originates **no data of its own**: every datum comes from a fixture file or the
 * proxy target.
 *
 * Every response is read **fresh from disk** (see `project.ts`) and sent
 * `Cache-Control: no-store`, so an edit is reflected the moment a consumer
 * re-asks; the file watcher's job is only to *tell* the browser to re-ask
 * (`watch.ts` → {@link DevServer.reload}). `Access-Control-Allow-Origin: *` lets
 * the dashboard, on its own origin, import the entry and fetch the dev state
 * (the dashboard owns its per-session dev CSP gate — SPEC §4).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { formatCapability } from '@gridmason/protocol';
import { ENDPOINTS } from './endpoints.js';
import { renderHarness } from './harness.js';
import {
  InspectorLog,
  type ObservationOutcome,
  type RawObservation,
  renderInspector,
} from './inspector.js';
import {
  type DevProject,
  declaredCapabilities,
  loadContext,
  loadFixtures,
  loadManifest,
} from './project.js';
import { type ProxyOutcome, type SdkCall, enforceAndForward } from './proxy.js';

/** What kind of edit a {@link DevServer.reload} announces to connected browsers. */
export type ReloadCategory = 'source' | 'manifest' | 'fixtures' | 'context';

/** Options for {@link createDevServer}. */
export interface DevServerOptions {
  /** The widget project to serve. */
  readonly project: DevProject;
  /** Port to listen on; `0` lets the OS assign one (used by tests). */
  readonly port: number;
  /** Interface to bind; defaults to `127.0.0.1` (localhost-only, per SPEC §4). */
  readonly host?: string;
  /** A `--context <name>` preset to mount instead of `default.json`'s context. */
  readonly contextName?: string;
  /** A `--proxy <host-url>`: forward SDK calls to this real host (enforced). */
  readonly proxyUrl?: string;
  /** The CLI package root, used to resolve `@gridmason/*` browser ESM as a fallback. */
  readonly cliRoot: string;
}

/** A running dev server. */
export interface DevServer {
  /** The `http://host:port` base the server is listening on. */
  readonly url: string;
  /** The bound port (resolved even when `0` was requested). */
  readonly port: number;
  /** The current cache-busting generation token (bumped on source/manifest reloads). */
  generation(): number;
  /** Announce an edit: bump the generation when needed and notify SSE clients. */
  reload(category: ReloadCategory): void;
  /** Stop listening and end every open SSE stream. */
  close(): Promise<void>;
}

/** Start the dev server and resolve once it is listening. */
export function createDevServer(options: DevServerOptions): Promise<DevServer> {
  const host = options.host ?? '127.0.0.1';
  const sseClients = new Set<ServerResponse>();
  const inspector = new InspectorLog();
  let generation = 1;

  /** Push one enriched observation to every connected SSE client as an `inspect` frame. */
  function broadcastInspect(observation: unknown): void {
    const payload = JSON.stringify(observation);
    for (const client of sseClients) client.write(`event: inspect\ndata: ${payload}\n\n`);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    const pathname = url.pathname;

    if (pathname === ENDPOINTS.harness) return serveHarness(res);
    if (pathname === ENDPOINTS.manifest) return serveManifest(res);
    if (pathname === ENDPOINTS.capabilities) return serveCapabilities(res);
    if (pathname === ENDPOINTS.fixtures) return serveFixtures(res);
    if (pathname === ENDPOINTS.context) return serveContext(res);
    if (pathname === ENDPOINTS.events) return serveEvents(req, res);
    if (pathname === ENDPOINTS.inspector) return serveInspector(res);
    if (pathname === ENDPOINTS.inspect) return serveInspect(req, res);
    if (pathname === ENDPOINTS.sdk) return serveSdk(req, res);
    if (pathname.startsWith(ENDPOINTS.npm)) return serveNpm(pathname, res);
    return serveSource(pathname, res);
  }

  async function serveHarness(res: ServerResponse): Promise<void> {
    const manifest = await loadManifest(options.project);
    if (!manifest.manifest || typeof manifest.manifest.entry !== 'string' || typeof manifest.manifest.tag !== 'string') {
      sendHtml(res, 200, harnessError(manifest.violations));
      return;
    }
    const html = renderHarness({
      tag: manifest.manifest.tag,
      entryUrl: '/' + manifest.manifest.entry.replace(/^\/+/, ''),
      generation,
      mode: options.proxyUrl ? 'proxy' : 'fixture',
    });
    sendHtml(res, 200, html);
  }

  async function serveManifest(res: ServerResponse): Promise<void> {
    const state = await loadManifest(options.project);
    sendJson(res, 200, {
      valid: state.valid,
      violations: state.violations,
      tag: state.manifest?.tag ?? null,
      entry: state.manifest?.entry ?? null,
    });
  }

  async function serveCapabilities(res: ServerResponse): Promise<void> {
    const state = await loadManifest(options.project);
    sendJson(res, 200, declaredCapabilities(state));
  }

  async function serveFixtures(res: ServerResponse): Promise<void> {
    sendJson(res, 200, await loadFixtures(options.project));
  }

  async function serveContext(res: ServerResponse): Promise<void> {
    try {
      const active = await loadContext(options.project, options.contextName);
      sendJson(res, 200, active);
    } catch (err) {
      sendJson(res, 404, { error: (err as Error).message });
    }
  }

  function serveEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  }

  /** Serve the standalone SDK-inspector page for the current manifest tag + mode. */
  async function serveInspector(res: ServerResponse): Promise<void> {
    const state = await loadManifest(options.project);
    sendHtml(
      res,
      200,
      renderInspector({ tag: state.manifest?.tag ?? '(unknown widget)', mode: options.proxyUrl ? 'proxy' : 'fixture' }),
    );
  }

  /**
   * The inspector data channel. GET returns the current session — the live
   * declared capabilities plus every call observed since the current mount. POST
   * records one gated call the fixture harness saw the widget make, enriches it
   * against the live manifest, and broadcasts it to the inspector over SSE.
   */
  async function serveInspect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const state = await loadManifest(options.project);
    if (req.method === 'GET') {
      sendJson(res, 200, {
        declared: declaredCapabilities(state).map(formatCapability),
        calls: inspector.list(),
      });
      return;
    }
    if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
    const raw = (await readJsonBody(req)) as RawObservation;
    const observation = inspector.add(raw, declaredCapabilities(state));
    broadcastInspect(observation);
    sendJson(res, 200, { ok: true });
  }

  async function serveSdk(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return void sendJson(res, 405, { error: 'method not allowed' });
    if (!options.proxyUrl) {
      // Fixture mode answers SDK calls in the browser via createFixtureSDK; the
      // server only mediates SDK calls when it is forwarding to a --proxy target.
      return void sendJson(res, 409, { error: 'SDK proxy is only available in --proxy mode' });
    }
    const call = (await readJsonBody(req)) as SdkCall;
    const state = await loadManifest(options.project);
    const outcome = await enforceAndForward(call, declaredCapabilities(state), options.proxyUrl);
    // A --proxy mount routes every SDK call through the server, so record it for
    // the inspector here — the fixture recorder the harness reports from is only
    // present in fixture mode.
    const observation = inspector.add(
      { method: call.method, outcome: proxyOutcomeTag(outcome), arg: call.args?.[0] },
      declaredCapabilities(state),
    );
    broadcastInspect(observation);
    sendJson(res, 200, outcome);
  }

  async function serveNpm(pathname: string, res: ServerResponse): Promise<void> {
    const subpath = decodeURIComponent(pathname.slice(ENDPOINTS.npm.length));
    const file = await resolveNpmFile(subpath, options.project.root, options.cliRoot);
    if (file === null) return void sendJson(res, 404, { error: `not found: ${subpath}` });
    await sendFile(res, file);
  }

  async function serveSource(pathname: string, res: ServerResponse): Promise<void> {
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = safeJoin(options.project.root, rel);
    if (file === null) return void sendJson(res, 403, { error: 'path escapes project root' });
    try {
      const info = await stat(file);
      if (!info.isFile()) return void sendJson(res, 404, { error: 'not found' });
    } catch {
      return void sendJson(res, 404, { error: 'not found' });
    }
    await sendFile(res, file);
  }

  return new Promise<DevServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      resolve({
        url: `http://${host}:${port}`,
        port,
        generation: () => generation,
        reload(category) {
          if (category === 'source' || category === 'manifest') generation += 1;
          // Every reload re-mounts the widget on a fresh SDK, so the observed-call
          // log starts over — the inspector reflects the current code, not a stale
          // accumulation across edits (its `reload` SSE listener re-pulls the session).
          inspector.clear();
          const payload = JSON.stringify({ category, generation });
          for (const client of sseClients) client.write(`event: reload\ndata: ${payload}\n\n`);
        },
        async close() {
          for (const client of sseClients) client.end();
          sseClients.clear();
          await new Promise<void>((res2, rej2) => server.close((err) => (err ? rej2(err) : res2())));
        },
      });
    });
  });
}

/** Map a `--proxy` {@link ProxyOutcome} to the inspector's {@link ObservationOutcome} tag. */
function proxyOutcomeTag(outcome: ProxyOutcome): ObservationOutcome {
  switch (outcome.status) {
    case 'denied':
      return 'denied';
    case 'error':
      return 'proxy-error';
    default:
      return 'proxied';
  }
}

/** The placeholder page shown when the manifest cannot name a tag + entry to mount. */
function harnessError(violations: readonly string[]): string {
  const list = violations.length ? violations.map((v) => `<li>${v}</li>`).join('') : '<li>manifest.json not found</li>';
  return `<!doctype html><meta charset="utf-8"><title>gridmason dev</title><body style="font-family:system-ui,sans-serif;padding:24px"><h1>gridmason dev</h1><p>Cannot mount the widget — the manifest is not usable yet:</p><ul>${list}</ul><p>Fix <code>manifest.json</code> and this page reloads.</p></body>`;
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Stream a file with a `no-store` content-type response. */
async function sendFile(res: ServerResponse, file: string): Promise<void> {
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  await pipeline(createReadStream(file), res);
}

/** Send a JSON body with a `no-store` header. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Send an HTML body with a `no-store` header. */
function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** Permissive CORS so the dashboard (a different origin) can import + fetch. */
function setCors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

/** Read and JSON-parse a request body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/**
 * Join `rel` under `root`, returning `null` if it escapes the root (a `..`
 * traversal). The dev server serves only files inside the project tree.
 */
export function safeJoin(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

/**
 * Resolve a `@gridmason/*` browser-ESM subpath to a file on disk: the widget
 * project's own `node_modules` first (the version the author installed), then the
 * CLI's own as a fallback. Only `@gridmason/*` subpaths are served.
 */
async function resolveNpmFile(subpath: string, projectRoot: string, cliRoot: string): Promise<string | null> {
  if (!subpath.startsWith('@gridmason/')) return null;
  for (const base of [path.join(projectRoot, 'node_modules'), path.join(cliRoot, 'node_modules')]) {
    const file = safeJoin(base, subpath);
    if (file === null) continue;
    try {
      if ((await stat(file)).isFile()) return file;
    } catch {
      // try the next base
    }
  }
  return null;
}
