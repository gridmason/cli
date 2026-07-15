/**
 * `gridmason lint --registry` integration tests (SPEC §5 checks 3–4, FR-12) — the
 * full command path over the **real** {@link HttpRegistryClient} against a **fake
 * registry HTTP server** that speaks the cross-repo contract (gridmason/registry#31):
 *
 * - `GET  /v1/tags/:tag/capabilities` → the last published version's capabilities,
 *   or `404` for a never-published tag;
 * - `POST /v1/dependencies/validate` → the acyclicity verdict for the submitted graph.
 *
 * The acceptance bar lives here: a capability-increase fixture reports the re-review
 * warning, and a server-detected cycle fails the run pre-publish. Every emitted
 * `--json` report is validated against the shipped report schema.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Ajv, type ValidateFunction } from 'ajv';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IO } from '../src/io.js';
import { run } from '../src/cli.js';
import { runLint } from '../src/lint/index.js';
import { planScaffold } from '../src/init/files.js';
import { writeProject } from '../src/init/scaffold.js';

/** A capturing IO sink. */
function capture(): { io: IO; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out: () => out.join(''), err: () => err.join('') };
}

/** How the fake registry should answer this test's two endpoints. */
interface FakeRegistryBehavior {
  /** Response to `GET /v1/tags/:tag/capabilities`: a record (200), `null` (404), or a status to force. */
  capabilities?: { registryId?: string; tag?: string; version: string; capabilities: { api: string; scope?: string }[] } | null | number;
  /** Response to `POST /v1/dependencies/validate`. */
  dag?: { acyclic: boolean; cycle?: string[] | null; registryId?: string } | number;
  /** Captured request bodies, for asserting the CLI sent the right graph. */
  dagRequests?: unknown[];
}

/** Start a fake registry HTTP server driven by `behavior`; returns its base URL + a close fn. */
async function startFakeRegistry(behavior: FakeRegistryBehavior): Promise<{ url: string; server: Server }> {
  behavior.dagRequests = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && /^\/v1\/tags\/[^/]+\/capabilities$/.test(url)) {
      const cap = behavior.capabilities;
      if (cap === undefined || cap === null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'unknown_tag', message: 'never published' } }));
        return;
      }
      if (typeof cap === 'number') {
        res.writeHead(cap, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'boom', message: 'forced' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(cap));
      return;
    }
    if (req.method === 'POST' && url === '/v1/dependencies/validate') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        behavior.dagRequests?.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        const dag = behavior.dag;
        if (typeof dag === 'number') {
          res.writeHead(dag, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'boom', message: 'forced' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(dag ?? { acyclic: true, cycle: null }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: url } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}

/** Close a server. */
function stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

let validateReport: ValidateFunction;
beforeAll(async () => {
  const schemaPath = fileURLToPath(new URL('../schemas/lint-report.schema.json', import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as object;
  validateReport = new Ajv({ strict: false, allErrors: true }).compile(schema);
});

function expectValidReport(report: unknown): void {
  expect(validateReport(report), JSON.stringify(validateReport.errors)).toBe(true);
}

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gm-lint-reg-'));
  const scaffold = planScaffold({ name: 'Sales Chart', publisher: 'acme', kind: 'widget', framework: 'vanilla' });
  root = path.join(dir, scaffold.directory);
  await writeProject(root, scaffold.files);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Overwrite the scaffold manifest with `fields`, keeping it schema-valid; returns its tag. */
async function writeManifest(fields: Record<string, unknown>): Promise<string> {
  const base = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ...base, ...fields }, null, 2));
  return base.tag as string;
}

describe('capability diff (check 3) over the real client', () => {
  it('flags a capability increase as a re-review warning without failing the run', async () => {
    const { url, server } = await startFakeRegistry({
      capabilities: { tag: 'acme-chart', version: '1.0.0', capabilities: [{ api: 'net', scope: 'a.example.com' }] },
    });
    try {
      // Manifest declares one more capability than the last published version.
      await writeManifest({ capabilities: [{ api: 'net', scope: 'a.example.com' }, { api: 'records.read' }] });
      const cap = capture();
      const code = await runLint({ cwd: root, registry: url, json: true }, cap.io);
      expect(code).toBe(0); // a warn does not fail the gate
      const report = JSON.parse(cap.out());
      expectValidReport(report);
      const diff = report.results.find((r: { id: string }) => r.id === 'capability.diff');
      expect(diff).toMatchObject({ status: 'warn', tier: 'reReview' });
      expect(diff.message).toContain('records.read');
      expect(diff.message).toContain('will re-trigger review');
      expect(report.tiers.reReview).toMatchObject({ id: 'reReview', sla: '3d' });
    } finally {
      await stop(server);
    }
  });

  it('passes when the tag was never published (first publish, 404)', async () => {
    const { url, server } = await startFakeRegistry({ capabilities: null });
    try {
      await writeManifest({ capabilities: [{ api: 'net', scope: 'a.example.com' }] });
      const cap = capture();
      expect(await runLint({ cwd: root, registry: url, json: true }, cap.io)).toBe(0);
      const diff = JSON.parse(cap.out()).results.find((r: { id: string }) => r.id === 'capability.diff');
      expect(diff).toMatchObject({ status: 'pass' });
      expect(diff.message).toContain('first publish');
    } finally {
      await stop(server);
    }
  });

  it('passes when capabilities are unchanged', async () => {
    const caps = [{ api: 'net', scope: 'a.example.com' }];
    const { url, server } = await startFakeRegistry({ capabilities: { tag: 'acme-chart', version: '1.5.0', capabilities: caps } });
    try {
      await writeManifest({ capabilities: caps });
      const cap = capture();
      expect(await runLint({ cwd: root, registry: url, json: true }, cap.io)).toBe(0);
      const diff = JSON.parse(cap.out()).results.find((r: { id: string }) => r.id === 'capability.diff');
      expect(diff).toMatchObject({ status: 'pass' });
    } finally {
      await stop(server);
    }
  });
});

describe('server DAG validation (check 4) over the real client', () => {
  it('fails the run when the registry reports a cycle pre-publish', async () => {
    const { url, server } = await startFakeRegistry({
      dag: { acyclic: false, cycle: ['acme-chart', 'other-grid', 'acme-chart'] },
    });
    try {
      await writeManifest({ requires: [{ tag: 'other-grid', range: '^2.0.0' }] });
      const cap = capture();
      const code = await runLint({ cwd: root, registry: url, json: true }, cap.io);
      expect(code).toBe(1);
      const report = JSON.parse(cap.out());
      expectValidReport(report);
      expect(report.status).toBe('fail');
      const dag = report.results.find((r: { id: string }) => r.id === 'deps.server-acyclic');
      expect(dag).toMatchObject({ status: 'fail', tier: 'automated' });
      expect(dag.message).toContain('acme-chart → other-grid → acme-chart');
    } finally {
      await stop(server);
    }
  });

  it('submits the manifest tag and requires edges, and passes on an acyclic verdict', async () => {
    const behavior: FakeRegistryBehavior = { dag: { acyclic: true, cycle: null } };
    const { url, server } = await startFakeRegistry(behavior);
    try {
      const tag = await writeManifest({ requires: [{ tag: 'other-grid', range: '^2.0.0' }] });
      const cap = capture();
      expect(await runLint({ cwd: root, registry: url, json: true }, cap.io)).toBe(0);
      const dag = JSON.parse(cap.out()).results.find((r: { id: string }) => r.id === 'deps.server-acyclic');
      expect(dag).toMatchObject({ status: 'pass' });
      expect(behavior.dagRequests).toEqual([{ tag, requires: [{ tag: 'other-grid', range: '^2.0.0' }] }]);
    } finally {
      await stop(server);
    }
  });
});

describe('registry unreachable', () => {
  it('degrades both registry checks to warnings without failing the gate', async () => {
    // A port with nothing listening: the client's fetch fails.
    const cap = capture();
    const code = await runLint({ cwd: root, registry: 'http://127.0.0.1:1', json: true }, cap.io);
    expect(code).toBe(0); // transport failure is a warn, not a fail
    const report = JSON.parse(cap.out());
    expectValidReport(report);
    const diff = report.results.find((r: { id: string }) => r.id === 'capability.diff');
    // capability.diff always runs; deps.server-acyclic only calls when requires is non-empty
    expect(diff).toMatchObject({ status: 'warn' });
  });
});

describe('offline lint is unchanged (no --registry, no registry checks)', () => {
  it('does not emit the registry-aware checks without --registry', async () => {
    const cap = capture();
    expect(await runLint({ cwd: root, json: true }, cap.io)).toBe(0);
    const ids = JSON.parse(cap.out()).results.map((r: { id: string }) => r.id);
    expect(ids).not.toContain('capability.diff');
    expect(ids).not.toContain('deps.server-acyclic');
  });
});

describe('command wiring (through the argument parser)', () => {
  it('runs the registry checks via `lint <path> --registry <url> --json`', async () => {
    const { url, server } = await startFakeRegistry({
      capabilities: { tag: 'acme-chart', version: '1.0.0', capabilities: [] },
    });
    try {
      await writeManifest({ capabilities: [{ api: 'events' }], requires: [] });
      const cap = capture();
      const code = await run(['lint', root, '--registry', url, '--json'], cap.io);
      expect(code).toBe(0);
      const ids = JSON.parse(cap.out()).results.map((r: { id: string }) => r.id);
      expect(ids).toContain('capability.diff');
      expect(ids).toContain('deps.server-acyclic');
    } finally {
      await stop(server);
    }
  });
});
