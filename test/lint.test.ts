/**
 * `gridmason lint` orchestration tests (SPEC §5, FR-7): manifest discovery,
 * human vs `--json` output, and the exit-code contract (0 iff no check failed).
 * The check logic itself is covered by `checks.test.ts`; this drives the glue and
 * the command wiring end to end.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IO } from '../src/io.js';
import { run } from '../src/cli.js';
import { runLint } from '../src/lint/index.js';
import { planScaffold } from '../src/init/files.js';
import { writeProject } from '../src/init/scaffold.js';

/** A capturing IO sink. */
function capture(): { io: IO; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: { out: (s) => outChunks.push(s), err: (s) => errChunks.push(s) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gm-lint-'));
  const scaffold = planScaffold({ name: 'Sales Chart', publisher: 'acme', kind: 'widget', framework: 'vanilla' });
  root = path.join(dir, scaffold.directory);
  await writeProject(root, scaffold.files);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runLint on a fresh scaffold', () => {
  it('reports every check passing and exits 0 (human output on stderr)', async () => {
    const cap = capture();
    const code = await runLint({ cwd: root }, cap.io);
    expect(code).toBe(0);
    expect(cap.err()).toContain('✓ manifest.schema');
    expect(cap.err()).toContain('✓ manifest.tag');
    expect(cap.err()).toContain('✓ manifest.capabilities');
    expect(cap.out()).toBe(''); // nothing on stdout without --json
  });

  it('emits a single JSON report on stdout with --json and exits 0', async () => {
    const cap = capture();
    const code = await runLint({ cwd: root, json: true }, cap.io);
    expect(code).toBe(0);
    const report = JSON.parse(cap.out()) as { command: string; status: string; results: { id: string }[] };
    expect(report.command).toBe('lint');
    expect(report.status).toBe('pass');
    // Manifest lint (#11) plus the #12 static-analysis checks, all passing on a
    // fresh scaffold — inclusion, so #13's added check does not break this.
    expect(report.results.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        'manifest.schema',
        'manifest.tag',
        'manifest.capabilities',
        'sdk.raw-network',
        'sdk.token-reach',
        'sdk.obfuscation',
        'dom.abuse',
      ]),
    );
    expect(cap.err()).toBe(''); // diagnostics stay off stdout's channel
  });

  it('resolves a project via the [path] argument', async () => {
    const cap = capture();
    const code = await runLint({ cwd: dir, path: 'sales-chart', json: true }, cap.io);
    expect(code).toBe(0);
    expect(JSON.parse(cap.out()).status).toBe('pass');
  });
});

describe('runLint on a broken manifest', () => {
  it('fails with exit 1 and a fail status', async () => {
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        formatVersion: '1.0',
        tag: 'other-widget',
        kind: 'widget',
        name: 'X',
        publisher: 'acme',
        version: '1.0.0',
        entry: 'widget.js',
      }),
    );
    const cap = capture();
    const code = await runLint({ cwd: root, json: true }, cap.io);
    expect(code).toBe(1);
    const report = JSON.parse(cap.out()) as { status: string; results: { id: string; status: string }[] };
    expect(report.status).toBe('fail');
    expect(report.results.some((r) => r.id === 'manifest.tag' && r.status === 'fail')).toBe(true);
  });
});

describe('runLint runs the #12 static analysis over the project source', () => {
  it('fails a widget whose entry does raw network I/O (sdk.raw-network)', async () => {
    // Plant a raw fetch in the scaffold's entry; the manifest stays valid, so the
    // failure must come from the source-analysis check reading src/ off disk.
    await writeFile(path.join(root, 'src', 'entry.js'), "export function boot() {\n  return fetch('/exfiltrate');\n}\n");
    const cap = capture();
    const code = await runLint({ cwd: root, json: true }, cap.io);
    expect(code).toBe(1);
    const report = JSON.parse(cap.out()) as { status: string; results: { id: string; status: string; message: string }[] };
    expect(report.status).toBe('fail');
    const net = report.results.find((r) => r.id === 'sdk.raw-network' && r.status === 'fail');
    expect(net, JSON.stringify(report.results)).toBeDefined();
    expect(net?.message).toContain('src/entry.js');
  });

  it('surfaces DOM abuse as a warn without failing the run', async () => {
    await writeFile(path.join(root, 'src', 'entry.js'), "export function boot() {\n  document.body.appendChild(document.createElement('div'));\n}\n");
    const cap = capture();
    const code = await runLint({ cwd: root, json: true }, cap.io);
    expect(code).toBe(0); // a warn does not fail the gate
    const report = JSON.parse(cap.out()) as { status: string; results: { id: string; status: string }[] };
    expect(report.results.some((r) => r.id === 'dom.abuse' && r.status === 'warn')).toBe(true);
  });
});

describe('runLint load failures', () => {
  it('reports no-manifest with exit 1 when the directory has no manifest', async () => {
    const cap = capture();
    const code = await runLint({ cwd: dir, path: '.', json: true }, cap.io); // dir itself holds no manifest
    expect(code).toBe(1);
    expect(JSON.parse(cap.out())).toMatchObject({ command: 'lint', status: 'error', code: 'no-manifest' });
  });

  it('reports invalid-json with exit 1 when the manifest is not JSON', async () => {
    await writeFile(path.join(root, 'manifest.json'), '{ not json');
    const cap = capture();
    const code = await runLint({ cwd: root, json: true }, cap.io);
    expect(code).toBe(1);
    expect(JSON.parse(cap.out())).toMatchObject({ command: 'lint', status: 'error', code: 'invalid-json' });
  });
});

describe('lint command wiring (through the argument parser)', () => {
  it('exits 0 on a clean project and 1 on a broken one', async () => {
    const clean = capture();
    expect(await run(['lint', root, '--json'], clean.io)).toBe(0);
    expect(JSON.parse(clean.out()).status).toBe('pass');

    await writeFile(path.join(root, 'manifest.json'), '{ not json');
    const broken = capture();
    expect(await run(['lint', root, '--json'], broken.io)).toBe(1);
    expect(JSON.parse(broken.out()).code).toBe('invalid-json');
  });
});
