/**
 * The shared review checks (SPEC §5, §8) — placeholder skeleton. The registry
 * service imports this module (`@gridmason/cli/checks`) so that `gridmason lint`
 * and the registry's automated review run the *identical* code path: local-green
 * predicts review-pass, by construction. The L-E2 epic (#11-#14) fills in the
 * manifest lint, SDK-adherence static analysis, and dependency-DAG checks.
 */
import type { Manifest } from '@gridmason/protocol';

/** Everything a check needs to make a decision. Grows as checks land. */
export interface CheckContext {
  /** The parsed widget manifest under review (protocol §3.1). */
  manifest: Manifest;
  /** Target registry, when running a registry-aware check (`--registry`). */
  registry?: string;
}

/** A single check outcome, mapped to a registry review tier as checks land. */
export interface CheckResult {
  /** Stable check id, echoed by registry review findings so the two align. */
  id: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

/** A check: pure function from context to zero or more results. */
export type Check = (ctx: CheckContext) => CheckResult[];

/** The registered checks. Empty until the L-E2 epic populates it. */
export const checks: readonly Check[] = [];
