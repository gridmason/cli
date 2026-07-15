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
 *
 * The **registry-aware** checks (`capability.diff`, `deps.server-acyclic`; #19)
 * are exported alongside but are a separate, *asynchronous* surface: they call the
 * target registry, so they run only under `gridmason lint --registry` and are not
 * part of the offline {@link checks} array the registry service imports verbatim.
 * They share the {@link CheckResult} shape, the check-id scheme, and the tier
 * mapping, so their findings land in the same `--json` report.
 */
export type { Check, CheckContext, CheckResult, CheckStatus, RawCapability, SourceFile } from './types.js';
export { checks, runChecks, hasFailure } from './run.js';
export {
  registryChecks,
  runRegistryChecks,
  capabilityDiffCheck,
  serverDagCheck,
  type RegistryCheck,
  type RegistryCheckContext,
} from './registry.js';
export {
  HttpRegistryClient,
  MAX_REGISTRY_RESPONSE_BYTES,
  type RegistryClient,
  type PublishedCapabilities,
  type DagValidationRequest,
  type DagValidationResult,
  type RequiresEdge,
} from './registry-client.js';
export {
  manifestChecks,
  manifestSchemaCheck,
  manifestTagCheck,
  manifestCapabilitiesCheck,
} from './manifest.js';
export { sdkChecks, sdkRawNetworkCheck, sdkTokenReachCheck, sdkObfuscationCheck } from './sdk.js';
export { domChecks, domAbuseCheck } from './dom.js';
export { dependencyChecks, dependencyDagCheck, findRequiresCycle } from './deps.js';
export {
  REVIEW_TIERS,
  TIER_BY_GROUP,
  tierForCheckId,
  type ReviewTier,
  type ReviewTierId,
} from './tiers.js';
