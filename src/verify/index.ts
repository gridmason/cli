/**
 * The `verify` command's engine (SPEC §6): a thin consumer of the
 * `@gridmason/protocol` verification library. Resolves the untrusted inputs and
 * the operator's pinned trust roots, then delegates the whole dual-signature +
 * content-hash + transparency-log decision to the protocol — `verifyRelease` for
 * the online path (`verify <artifact|url>`) and `verifyOfflineBundle` for the
 * air-gapped `.gmb` path (`verify --offline`). Both refuse a blind/unpinned root
 * (SPEC §4.4) and render through the one shared verdict seam.
 *
 * The stable verdict vocabulary is the protocol's own — re-exported here (not
 * re-mapped) so callers, tests, and telemetry switch on the single source of
 * truth.
 */
export { runVerify, type VerifyRunDeps, type VerifyRunArgs } from './run.js';
export {
  runVerifyOffline,
  enforcePackedFiles,
  resolveGmbBundle,
  isSafeRelativePath,
  validatePayloadFiles,
  MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_TOTAL_BYTES,
  type VerifyOfflineDeps,
  type VerifyOfflineArgs,
  type PackedFilesResult,
  type BundleSourceResult,
} from './bundle.js';
export { formatVerdict, type VerifyOutcome, type VerifyErrorCode, type VerdictRender } from './verdict.js';
export { loadTrustConfig, type TrustConfig, type TrustConfigResult, type TrustConfigSource } from './trust-config.js';
export { resolveVerificationInput, type VerificationInput, type SourceResult } from './source.js';

// The stable verdict enums are the protocol's — surfaced verbatim, never remapped.
// `VERIFY_BUNDLE_REASONS` is the offline superset (the release set + the two
// bundle-only archive-integrity classes).
export {
  VERIFY_RELEASE_REASONS,
  VERIFY_BUNDLE_REASONS,
  type VerifyReleaseReason,
  type VerifyBundleReason,
} from '@gridmason/protocol';
