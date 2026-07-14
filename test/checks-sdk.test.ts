/**
 * SDK-adherence + DOM-abuse static-analysis tests (SPEC §5.2/§5.5, FR-7, #12).
 *
 * The acceptance is a seeded-violation suite with two halves:
 * - **planted violations catch** — every case in `src/checks/fixtures/index.ts`
 *   is flagged by *its own* check at the right severity, and by no other source
 *   check (no cross-talk);
 * - **clean templates pass** — a fresh `gridmason init` scaffold (every
 *   framework) trips nothing, so the checks add zero false positives to the
 *   author loop.
 *
 * Plus the contract edges: a source check with no `sourceFiles` defers (emits
 * nothing, like a manifest check whose field is absent), and the new ids are
 * registered in the shared array the registry imports.
 */
import { describe, expect, it } from 'vitest';
import {
  checks,
  domAbuseCheck,
  domChecks,
  hasFailure,
  sdkChecks,
  sdkObfuscationCheck,
  sdkRawNetworkCheck,
  sdkTokenReachCheck,
  type Check,
  type CheckResult,
  type SourceFile,
} from '../src/checks/index.js';
import { FRAMEWORKS, type Framework } from '../src/templates/index.js';
import { planScaffold } from '../src/init/files.js';
import { violationCases } from '../src/checks/fixtures/index.js';

/** The static-analysis checks under test, keyed by id. */
const sourceChecks: readonly Check[] = [...sdkChecks, ...domChecks];
const byId = new Map(sourceChecks.map((c) => [c.id, c]));

/** Only the non-pass findings — the ones a violation should (or should not) produce. */
function findings(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((r) => r.status !== 'pass');
}

/** Extensions the checks treat as widget source (matches the lint collector). */
const SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];
function isSource(path: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** The source files a fresh scaffold ships, shaped as a static-analysis context. */
function scaffoldSources(framework: Framework): SourceFile[] {
  const { files } = planScaffold({ name: 'Sales Chart', publisher: 'acme', kind: 'widget', framework });
  return files.filter((f) => isSource(f.path)).map((f) => ({ path: f.path, contents: f.contents }));
}

describe('planted violations — each heuristic catches its own sample', () => {
  it.each(violationCases)('$name → $checkId ($status)', (planted) => {
    const check = byId.get(planted.checkId);
    expect(check, `unknown check id ${planted.checkId}`).toBeDefined();
    const results = check!.run({ manifest: {}, sourceFiles: [planted.file] });
    const flagged = findings(results);
    // The owning check flags it, at the declared severity, naming the token.
    expect(flagged.length).toBeGreaterThan(0);
    expect(
      flagged.some((r) => r.status === planted.status && r.message.includes(planted.tokenIncludes)),
      JSON.stringify(flagged),
    ).toBe(true);
    // Every finding it emits carries a fix hint (feeds the #14 reference).
    expect(flagged.every((r) => r.hint !== undefined && r.hint.length > 0)).toBe(true);
  });

  it.each(violationCases)('$name → no cross-talk from the other source checks', (planted) => {
    for (const check of sourceChecks) {
      if (check.id === planted.checkId) continue;
      const flagged = findings(check.run({ manifest: {}, sourceFiles: [planted.file] }));
      expect(flagged, `${check.id} should stay clean on ${planted.name}: ${JSON.stringify(flagged)}`).toEqual([]);
    }
  });
});

describe('clean scaffolds pass with zero false positives (FR-7 acceptance)', () => {
  it.each(FRAMEWORKS)('a fresh %s scaffold trips no static-analysis check', (framework) => {
    const sources = scaffoldSources(framework);
    expect(sources.length).toBeGreaterThan(0);
    for (const check of sourceChecks) {
      const results = check.run({ manifest: {}, sourceFiles: sources });
      // Every source check emits a single pass over clean source — no warn/fail.
      expect(findings(results), `${check.id} on ${framework}: ${JSON.stringify(results)}`).toEqual([]);
      expect(results).toEqual([{ id: check.id, status: 'pass', message: expect.any(String) }]);
    }
  });
});

describe('source checks defer when there is nothing to read', () => {
  it('emit no result when sourceFiles is absent', () => {
    for (const check of sourceChecks) {
      expect(check.run({ manifest: {} })).toEqual([]);
    }
  });

  it('emit no result when sourceFiles is empty', () => {
    for (const check of sourceChecks) {
      expect(check.run({ manifest: {}, sourceFiles: [] })).toEqual([]);
    }
  });
});

describe('severity contract', () => {
  const cookie: SourceFile = { path: 'src/x.js', contents: 'const c = document.cookie;\n' };
  const evalFile: SourceFile = { path: 'src/x.js', contents: 'eval(payload);\n' };
  const domFile: SourceFile = { path: 'src/x.js', contents: "document.body.appendChild(el);\n" };

  it('raw network and credential reach are failures (gate the run)', () => {
    expect(hasFailure(sdkTokenReachCheck.run({ manifest: {}, sourceFiles: [cookie] }))).toBe(true);
    expect(hasFailure(sdkObfuscationCheck.run({ manifest: {}, sourceFiles: [evalFile] }))).toBe(true);
    expect(
      hasFailure(sdkRawNetworkCheck.run({ manifest: {}, sourceFiles: [{ path: 'a.js', contents: "fetch('/x');\n" }] })),
    ).toBe(true);
  });

  it('DOM abuse is a warn — surfaced without failing the local gate', () => {
    const results = domAbuseCheck.run({ manifest: {}, sourceFiles: [domFile] });
    expect(hasFailure(results)).toBe(false);
    expect(results.some((r) => r.status === 'warn')).toBe(true);
  });
});

describe('registration in the shared checks array (#14 reference source)', () => {
  it('registers the SDK-adherence and DOM-abuse ids', () => {
    const ids = checks.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['sdk.raw-network', 'sdk.token-reach', 'sdk.obfuscation', 'dom.abuse']));
  });

  it('every new check carries a stable id, title, and rationale', () => {
    for (const check of sourceChecks) {
      expect(check.id).toMatch(/^[a-z]+\.[a-z-]+$/);
      expect(check.title.length).toBeGreaterThan(0);
      expect(check.rationale.length).toBeGreaterThan(0);
    }
  });
});
