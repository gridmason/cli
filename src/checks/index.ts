/**
 * The shared review checks (SPEC §5, §8; FR-7, FR-8) — the public surface the
 * registry service imports verbatim as a **plain library** (`@gridmason/cli/checks`)
 * so `gridmason lint` and the registry's automated review run the *identical*
 * code path: local-green predicts review-pass, by construction (SPEC §8, "one
 * implementation, no divergence"). This module pulls in no CLI machinery
 * (commander, the binary, the IO sink) — importing it costs a consumer nothing
 * but the checks and `@gridmason/protocol` + `ajv`.
 *
 * The check-id scheme and the manifest-check rules are documented in
 * `docs/checks.md`; the L-E2 epic (#11–#14) fills in the manifest lint (here),
 * the SDK-adherence static analysis (#12), and the dependency-DAG check + the
 * `--json` report / tier mapping (#13).
 */
export type { Check, CheckContext, CheckResult, CheckStatus } from './types.js';
export { checks, runChecks, hasFailure } from './run.js';
export {
  manifestChecks,
  manifestSchemaCheck,
  manifestTagCheck,
  manifestCapabilitiesCheck,
} from './manifest.js';
export { dependencyChecks, dependencyDagCheck, findRequiresCycle } from './deps.js';
export {
  REVIEW_TIERS,
  TIER_BY_GROUP,
  tierForCheckId,
  type ReviewTier,
  type ReviewTierId,
} from './tiers.js';
