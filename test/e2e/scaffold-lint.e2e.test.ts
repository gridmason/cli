/**
 * End-to-end: the author's first two steps of the loop (SPEC §9), driven through
 * the **built binary** as a real subprocess — not the library in-process.
 *
 *   gridmason widget init <name> --framework <fw>   →   gridmason lint <dir>
 *
 * For every starter template (vanilla / React / Vue) this asserts the leg that
 * SPEC §5 promises: a fresh scaffold lints **clean** — exit 0, no failing check,
 * and a `--json` report that validates against the shipped report schema
 * (`schemas/lint-report.schema.json`). Because it runs the compiled `dist/bin`
 * end to end (argument parsing, exit codes, stdout/stderr channels, the checks
 * reading real files off disk), a regression in *any* check — or a template that
 * drifts into tripping one — fails this gate rather than shipping. The
 * dev-serve/publish legs of the §9 e2e are out of scope here (Phase B).
 *
 * The binary is built once by `test/e2e/global-setup.ts`, so this suite always
 * exercises the current source tree.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const binary = path.join(repoRoot, 'dist', 'bin', 'gridmason.js');
const reportSchemaPath = path.join(repoRoot, 'schemas', 'lint-report.schema.json');

/** The frameworks `gridmason widget init --framework` accepts, each with its own template. */
const FRAMEWORKS = ['vanilla', 'react', 'vue'] as const;

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the built binary as a subprocess and capture its exit code and streams. */
function runBin(args: string[], cwd: string): RunResult {
  const result = spawnSync(process.execPath, [binary, ...args], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A minimal shape of the `--json` lint report, enough to assert the contract. */
interface LintReport {
  command: string;
  status: string;
  results: { id: string; status: string }[];
}

let validateReport: ValidateFunction;
let workRoot: string;

beforeAll(async () => {
  // The report schema this repo owns and ships — a real CI consumer validates
  // against exactly this file, so the e2e does too (same draft-07 / strict-off
  // ajv the checks use).
  const schema = JSON.parse(await readFile(reportSchemaPath, 'utf8')) as object;
  validateReport = new Ajv({ strict: false, allErrors: true }).compile(schema);
  workRoot = await mkdtemp(path.join(tmpdir(), 'gm-e2e-'));
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe('scaffold → lint is green across every template (built binary, subprocess)', () => {
  it.each(FRAMEWORKS)('init --framework %s, then lint the scaffold clean', async (framework) => {
    const cwd = await mkdtemp(path.join(workRoot, `${framework}-`));

    // 1. Scaffold non-interactively, taking every answer from a flag.
    const init = runBin(
      ['widget', 'init', `sample-${framework}`, '--publisher', 'acme', '--kind', 'widget', '--framework', framework, '--json'],
      cwd,
    );
    expect(init.status, `init failed:\n${init.stderr}`).toBe(0);
    const created = JSON.parse(init.stdout) as { status: string; directory: string };
    expect(created.status).toBe('created');
    const projectDir = path.join(cwd, created.directory);

    // 2. Lint the fresh scaffold with --json — the machine gate a CI job reads.
    const lintJson = runBin(['lint', projectDir, '--json'], cwd);
    expect(lintJson.status, `lint --json failed:\n${lintJson.stderr}`).toBe(0);

    // The report is the only thing on stdout, and it validates against the schema.
    const report = JSON.parse(lintJson.stdout) as LintReport;
    expect(validateReport(report), JSON.stringify(validateReport.errors)).toBe(true);
    expect(report.command).toBe('lint');
    expect(report.status).toBe('pass');

    // No check failed — the exit code and the report agree, and the manifest +
    // source-analysis families all ran and passed. (`deps.acyclic` defers on a
    // scaffold with no `requires`, so it is correctly absent, not asserted.)
    expect(report.results.filter((r) => r.status === 'fail')).toEqual([]);
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

    // 3. The human leg: same clean pass, diagnostics on stderr, stdout empty.
    const lintHuman = runBin(['lint', projectDir], cwd);
    expect(lintHuman.status, `lint (human) failed:\n${lintHuman.stderr}`).toBe(0);
    expect(lintHuman.stdout).toBe('');
    expect(lintHuman.stderr).toContain('✓ manifest.schema');
  });
});
