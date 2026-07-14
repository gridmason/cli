/**
 * `gridmason lint --json` report tests (SPEC §5, FR-7). Two contracts:
 *
 * 1. **Schema conformance** — every object the command emits (pass, fail, and the
 *    load-error variant) validates against the report's authoritative JSON Schema,
 *    `schemas/lint-report.schema.json`, which this repo owns and ships.
 * 2. **Tier mapping** — every result is tagged with the registry review tier its
 *    check feeds, the `tiers` catalog resolves those ids, and every *registered*
 *    check maps to a tier explicitly (so a new check family is a one-line add, not
 *    a silent fall-through).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IO } from '../src/io.js';
import { runLint } from '../src/lint/index.js';
import { buildLintReport } from '../src/lint/report.js';
import { planScaffold } from '../src/init/files.js';
import { writeProject } from '../src/init/scaffold.js';
import { REVIEW_TIERS, TIER_BY_GROUP, checks, runChecks, tierForCheckId, type ReviewTier } from '../src/checks/index.js';

/** A capturing IO sink. */
function capture(): { io: IO; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out: () => out.join(''), err: () => err.join('') };
}

/** The report JSON Schema, compiled once — the same ajv the checks use (draft-07, strict off). */
let validateReport: ValidateFunction;

beforeAll(async () => {
  const schemaPath = fileURLToPath(new URL('../schemas/lint-report.schema.json', import.meta.url));
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as object;
  validateReport = new Ajv({ strict: false, allErrors: true }).compile(schema);
});

/** Validate a report object against the schema, surfacing ajv errors on failure. */
function expectValidReport(report: unknown): void {
  const ok = validateReport(report);
  expect(ok, JSON.stringify(validateReport.errors)).toBe(true);
}

describe('report schema conformance (real emitted --json)', () => {
  let dir: string;
  let root: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gm-report-'));
    const scaffold = planScaffold({ name: 'Sales Chart', publisher: 'acme', kind: 'widget', framework: 'vanilla' });
    root = path.join(dir, scaffold.directory);
    await writeProject(root, scaffold.files);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a clean pass report validates and carries the tiers catalog', async () => {
    const cap = capture();
    expect(await runLint({ cwd: root, json: true }, cap.io)).toBe(0);
    const report = JSON.parse(cap.out());
    expectValidReport(report);
    expect(report.status).toBe('pass');
    // Every result is tagged with a tier that the catalog resolves.
    for (const result of report.results) {
      expect(typeof result.tier).toBe('string');
      expect(report.tiers[result.tier]).toBeDefined();
    }
    // The manifest checks feed the automated review stage.
    expect(report.tiers.automated).toMatchObject({ id: 'automated', reference: 'registry §4.1' });
  });

  it('a cyclic-requires fail report validates and prints the cycle path', async () => {
    // A self-dependency: the one cycle a single manifest can prove.
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        formatVersion: '1.0',
        tag: 'acme-chart',
        kind: 'widget',
        name: 'Sales Chart',
        publisher: 'acme',
        version: '1.0.0',
        entry: 'widget.js',
        requires: [{ tag: 'acme-chart', range: '^1.0.0' }],
      }),
    );
    const cap = capture();
    expect(await runLint({ cwd: root, json: true }, cap.io)).toBe(1);
    const report = JSON.parse(cap.out());
    expectValidReport(report);
    expect(report.status).toBe('fail');
    const dag = report.results.find((r: { id: string }) => r.id === 'deps.acyclic');
    expect(dag).toMatchObject({ status: 'fail', tier: 'automated' });
    expect(dag.message).toContain('acme-chart → acme-chart');
  });

  it('the load-error variant (no manifest) validates', async () => {
    const cap = capture();
    expect(await runLint({ cwd: dir, path: '.', json: true }, cap.io)).toBe(1);
    const report = JSON.parse(cap.out());
    expectValidReport(report);
    expect(report).toMatchObject({ command: 'lint', status: 'error', code: 'no-manifest' });
  });
});

describe('tier mapping', () => {
  it('maps each documented group to its registry tier and SLA', () => {
    expect(tierForCheckId('manifest.schema').id).toBe('automated');
    expect(tierForCheckId('deps.acyclic').id).toBe('automated');
    expect(tierForCheckId('sdk.network').id).toBe('TF');
    expect(tierForCheckId('dom.abuse').id).toBe('TF');
    expect(REVIEW_TIERS.TF.sla).toBe('5d');
    expect(REVIEW_TIERS.T1.sla).toBe('2d');
    expect((REVIEW_TIERS.automated as ReviewTier).sla).toBeUndefined();
  });

  it('falls back to the automated stage for an unmapped group', () => {
    expect(tierForCheckId('mystery.thing').id).toBe('automated');
  });

  it('maps every REGISTERED check to a tier explicitly (no silent fall-through)', () => {
    // Guardrail: a new check family must add its group to TIER_BY_GROUP — this
    // fails if a registered check would only map via the default.
    for (const check of checks) {
      const group = check.id.split('.')[0] ?? '';
      expect(TIER_BY_GROUP, `check ${check.id} group "${group}" is unmapped`).toHaveProperty(group);
    }
  });

  it('buildLintReport tags results and collects only the referenced tiers', () => {
    const results = runChecks({ manifest: { not: 'valid' } });
    const report = buildLintReport(results, true);
    expect(report.status).toBe('fail');
    for (const result of report.results) {
      expect(report.tiers[result.tier]).toBeDefined();
    }
    // Only tiers actually referenced by a result appear in the catalog.
    for (const tierId of Object.keys(report.tiers)) {
      expect(report.results.some((r) => r.tier === tierId)).toBe(true);
    }
  });
});
