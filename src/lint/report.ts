/**
 * The `gridmason lint --json` report (SPEC §5, FR-7). This repo owns the report's
 * shape (cli-v0 spec, Data model: "lint report JSON schema defined here"); the
 * authoritative contract is `schemas/lint-report.schema.json` and every object
 * this module emits validates against it (asserted in the test suite).
 *
 * A report serializes **every** check result and maps each to the registry review
 * tier its findings feed, plus a `tiers` catalog resolving those ids to their SLA
 * (registry §4.2) — so a CI consumer reads, from one object, both what failed and
 * which review SLA the artifact will hit. A load failure (no/invalid manifest)
 * emits the {@link LintErrorReport} variant instead.
 */
import { tierForCheckId, type CheckResult, type ReviewTier } from '../checks/index.js';

/** A check result plus the id of the review tier it feeds (a key into {@link LintReport.tiers}). */
export interface LintReportResult extends CheckResult {
  /** The {@link ReviewTier.id} this check maps to (registry §4.2). */
  readonly tier: string;
}

/** The `--json` report for a run that read the manifest and ran the checks. */
export interface LintReport {
  readonly command: 'lint';
  /** `fail` iff any check failed; else `pass`. */
  readonly status: 'pass' | 'fail';
  /** Every check's finding, in check order, each tagged with its review tier. */
  readonly results: readonly LintReportResult[];
  /** The review tiers referenced by `results`, keyed by id — resolves each `tier` to its SLA. */
  readonly tiers: Readonly<Record<string, ReviewTier>>;
}

/** The `--json` report when the manifest could not be loaded (no run happened). */
export interface LintErrorReport {
  readonly command: 'lint';
  readonly status: 'error';
  /** Why the manifest could not be read — machine consumers switch on this. */
  readonly code: 'no-manifest' | 'invalid-json';
  readonly message: string;
}

/**
 * Build the structured report from a run's findings: tag each result with the
 * review tier its check id feeds and collect the referenced tiers into the
 * catalog. `failed` is the run's {@link import('../checks/index.js').hasFailure}
 * verdict, kept as an argument so the report's `status` cannot drift from the
 * process exit code.
 */
export function buildLintReport(results: readonly CheckResult[], failed: boolean): LintReport {
  const tiers: Record<string, ReviewTier> = {};
  const reportResults = results.map((result): LintReportResult => {
    const tier = tierForCheckId(result.id);
    tiers[tier.id] = tier;
    return { ...result, tier: tier.id };
  });
  return { command: 'lint', status: failed ? 'fail' : 'pass', results: reportResults, tiers };
}

/** Build the load-failure report variant. */
export function buildLintErrorReport(code: LintErrorReport['code'], message: string): LintErrorReport {
  return { command: 'lint', status: 'error', code, message };
}
