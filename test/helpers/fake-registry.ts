/**
 * A **contract-faithful fake of the registry Publish + review API** (registry
 * docs/api/publish.md, docs/review/*), used to drive the `publish`/`appeal` flow
 * end to end without standing up the real service (Postgres + object store + OIDC
 * verifier + reviewer config + countersign key). It is faithful where it matters:
 *
 * - `POST /v1/artifacts` verifies a bearer token is present, checks the tag is
 *   under the publisher prefix, content-addresses every part with the **same
 *   `@gridmason/protocol` hashing** the real registry uses, structurally validates
 *   the DSSE envelope, enforces `(tag, version)` immutability, and runs the
 *   **shared `src/checks` module** as its automated review — the very code
 *   `gridmason lint` runs — so a clean artifact advances to `reviewing` and a
 *   failing one to `rejected`, exactly as the real automated stage does.
 * - `GET /v1/artifacts/:id/status` / `POST /v1/artifacts/:id/appeal` are the
 *   publisher-facing status + second-review surfaces the flow needs (see the PR
 *   note: M-B1 advances state synchronously and exposes findings only on the
 *   reviewer-only lane, so these are served by the fake here).
 *
 * The same `handle()` core backs both an in-process {@link Transport} (unit tests,
 * no socket) and a real `http.Server` ({@link startFakeRegistry}, the e2e over
 * localhost).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashBytes } from '@gridmason/protocol';
import { runChecks, hasFailure, type CheckContext, type SourceFile } from '../../src/checks/index.js';
import type { Transport, HttpResponse } from '../../src/publish/transport.js';
import type { ReviewFinding } from '../../src/publish/upload.js';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

interface StoredArtifact {
  id: string;
  tag: string;
  version: string;
  state: 'submitted' | 'reviewing' | 'approved' | 'rejected';
  contentHashes: Record<string, string>;
  polls: number;
  findings: ReviewFinding[];
  appealed: boolean;
}

export interface FakeRegistryOptions {
  /** The single registered publisher's namespace prefix (tags must be `<prefix>-…`). */
  readonly publisherPrefix?: string;
  /** How many status polls a clean artifact stays `reviewing` before it is `approved`. */
  readonly approveAfterPolls?: number;
  /** Tags a (simulated) human reviewer rejects, with the findings the poll returns. */
  readonly rejectTags?: Readonly<Record<string, readonly ReviewFinding[]>>;
}

function json(status: number, body: unknown): HttpResponse {
  return { status, body };
}

function error(status: number, code: string, message: string): HttpResponse {
  return json(status, { error: { code, message } });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural DSSE check — payloadType + payload + non-empty signatures[] (registry publish.md). */
function isDsseShaped(env: unknown): boolean {
  return (
    isObject(env) &&
    typeof env.payloadType === 'string' &&
    typeof env.payload === 'string' &&
    Array.isArray(env.signatures) &&
    env.signatures.length > 0
  );
}

/** A fake registry instance: an in-memory store plus the request handler both transports share. */
export class FakeRegistry {
  private readonly prefix: string;
  private readonly approveAfterPolls: number;
  private readonly rejectTags: Readonly<Record<string, readonly ReviewFinding[]>>;
  private readonly store = new Map<string, StoredArtifact>();
  /** Every accepted upload's DSSE envelope, so a test can assert what was signed. */
  readonly uploadedEnvelopes: unknown[] = [];
  /** Count of upload attempts that reached `POST /v1/artifacts` (asserts "never upload known-bad"). */
  uploadAttempts = 0;
  private seq = 0;

  constructor(options: FakeRegistryOptions = {}) {
    this.prefix = options.publisherPrefix ?? 'acme';
    this.approveAfterPolls = options.approveAfterPolls ?? 1;
    this.rejectTags = options.rejectTags ?? {};
  }

  /** Handle one request; the pure core both the in-process transport and the HTTP server call. */
  async handle(method: string, path: string, headers: Record<string, string>, body: unknown): Promise<HttpResponse> {
    const hasToken = typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ');
    if (method === 'POST' && path === '/v1/artifacts') {
      this.uploadAttempts += 1;
      if (!hasToken) return error(401, 'missing_token', 'a bearer token is required');
      return this.upload(body);
    }
    const statusMatch = /^\/v1\/artifacts\/([^/]+)\/status$/.exec(path);
    if (method === 'GET' && statusMatch) {
      if (!hasToken) return error(401, 'missing_token', 'a bearer token is required');
      return this.status(decodeURIComponent(statusMatch[1]!));
    }
    const appealMatch = /^\/v1\/artifacts\/([^/]+)\/appeal$/.exec(path);
    if (method === 'POST' && appealMatch) {
      if (!hasToken) return error(401, 'missing_token', 'a bearer token is required');
      return this.appeal(decodeURIComponent(appealMatch[1]!));
    }
    return error(404, 'not_found', `no route for ${method} ${path}`);
  }

  private async upload(body: unknown): Promise<HttpResponse> {
    if (!isObject(body) || typeof body.tag !== 'string' || typeof body.version !== 'string' || !Array.isArray(body.files)) {
      return error(400, 'invalid_request', 'body missing tag/version/files');
    }
    const { tag, version, files } = body as { tag: string; version: string; files: unknown[] };
    if (!tag.startsWith(`${this.prefix}-`)) {
      return error(403, 'tag_not_in_prefix', `tag "${tag}" is not under this publisher's prefix "${this.prefix}"`);
    }
    if (!isDsseShaped(body.envelope)) {
      return error(400, 'invalid_envelope', 'the publisher signature envelope is missing or not DSSE-shaped');
    }
    const key = `${tag}@${version}`;
    if ([...this.store.values()].some((a) => `${a.tag}@${a.version}` === key)) {
      return error(409, 'version_exists', `version "${version}" of "${tag}" is already published and is immutable`);
    }

    // Parse the file parts and content-address them with the protocol hashing.
    const parsed: { path: string; role: string; bytes: Buffer }[] = [];
    for (const f of files) {
      if (!isObject(f) || typeof f.path !== 'string' || typeof f.role !== 'string' || typeof f.bytes !== 'string') {
        return error(400, 'invalid_artifact', 'a file part is malformed');
      }
      parsed.push({ path: f.path, role: f.role, bytes: Buffer.from(f.bytes, 'base64') });
    }
    const manifestPart = parsed.find((p) => p.role === 'manifest');
    const entryPart = parsed.find((p) => p.role === 'entry');
    if (!manifestPart || !entryPart) {
      return error(400, 'invalid_artifact', 'not exactly one manifest + one entry');
    }
    const contentHashes: Record<string, string> = {};
    for (const p of parsed) contentHashes[p.path] = await hashBytes(p.bytes);

    // Automated review with the shared checks — the identical code `gridmason lint` runs.
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestPart.bytes.toString('utf8'));
    } catch {
      return error(400, 'invalid_artifact', 'the manifest part is not valid JSON');
    }
    const sourceFiles: SourceFile[] = parsed
      .filter((p) => (p.role === 'entry' || p.role === 'chunk') && SOURCE_EXTENSIONS.has(p.path.slice(p.path.lastIndexOf('.'))))
      .map((p) => ({ path: p.path, contents: p.bytes.toString('utf8') }));
    const ctx: CheckContext = { manifest, sourceFiles };
    const failed = hasFailure(runChecks(ctx));

    this.uploadedEnvelopes.push(body.envelope);
    const id = `art-${++this.seq}`;
    const record: StoredArtifact = {
      id,
      tag,
      version,
      state: failed ? 'rejected' : 'reviewing',
      contentHashes,
      polls: 0,
      findings: [],
      appealed: false,
    };
    this.store.set(id, record);
    return json(201, this.present(record));
  }

  private status(id: string): HttpResponse {
    const record = this.store.get(id);
    if (!record) return error(404, 'not_found', `no artifact ${id}`);
    record.polls += 1;

    // A (simulated) human reviewer rejects a configured tag with findings.
    const reject = this.rejectTags[record.tag];
    if (reject && record.state === 'reviewing' && !record.appealed) {
      record.state = 'rejected';
      record.findings = [...reject];
    } else if (record.state === 'reviewing' && record.polls >= this.approveAfterPolls) {
      record.state = 'approved';
    }

    const review = record.findings.length > 0 ? { review: { findings: record.findings } } : {};
    return json(200, { ...this.present(record), ...review });
  }

  private appeal(id: string): HttpResponse {
    const record = this.store.get(id);
    if (!record) return error(404, 'not_found', `no artifact ${id}`);
    if (record.state !== 'rejected') {
      return error(409, 'not_appealable', `artifact ${id} is "${record.state}", not a rejected submission`);
    }
    // Route to a second reviewer: back to reviewing, findings cleared, and the
    // second lane approves (the second reviewer disagreed with the first).
    record.state = 'reviewing';
    record.findings = [];
    record.appealed = true;
    record.polls = 0;
    return json(201, this.present(record));
  }

  private present(record: StoredArtifact): Record<string, unknown> {
    return {
      id: record.id,
      registryId: 'registry.test',
      tag: record.tag,
      version: record.version,
      state: record.state,
      contentHashes: record.contentHashes,
      createdAt: '2026-07-14T00:00:00.000Z',
    };
  }

  /** An in-process {@link Transport} over {@link handle} — no socket, for unit tests. */
  transport(): Transport {
    return {
      request: async (method, url, options = {}) => {
        const parsed = new URL(url);
        const headers: Record<string, string> = {};
        if (options.token) headers.authorization = `Bearer ${options.token}`;
        return this.handle(method, parsed.pathname, headers, options.body);
      },
    };
  }
}

/** Start a real `http.Server` backed by a {@link FakeRegistry}; returns its base URL + a stop fn. */
export async function startFakeRegistry(registry: FakeRegistry): Promise<{ url: string; close: () => Promise<void>; registry: FakeRegistry }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = text.length > 0 ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }
        const headers: Record<string, string> = {};
        if (typeof req.headers.authorization === 'string') headers.authorization = req.headers.authorization;
        const url = new URL(req.url ?? '/', 'http://localhost');
        const result = await registry.handle(req.method ?? 'GET', url.pathname, headers, body);
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body ?? {}));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    registry,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
