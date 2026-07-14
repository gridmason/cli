/**
 * The `verify` command's engine (SPEC §6): a thin consumer of the
 * `@gridmason/protocol` verification library. Resolves the untrusted artifact
 * inputs and the operator's pinned trust roots, then delegates the whole
 * dual-signature + content-hash + transparency-log decision to `verifyRelease`.
 *
 * The stable verdict vocabulary is the protocol's own — re-exported here (not
 * re-mapped) so callers, tests, and telemetry switch on the single source of
 * truth. The offline `.gmb` path (deferred until protocol P-E4) will reuse
 * {@link formatVerdict} and {@link loadTrustConfig} unchanged.
 */
export { runVerify, type VerifyRunDeps, type VerifyRunArgs } from './run.js';
export { formatVerdict, type VerifyOutcome, type VerifyErrorCode, type VerdictRender } from './verdict.js';
export { loadTrustConfig, type TrustConfig, type TrustConfigResult, type TrustConfigSource } from './trust-config.js';
export { resolveVerificationInput, type VerificationInput, type SourceResult } from './source.js';

// The stable verdict enum is the protocol's — surfaced verbatim, never remapped.
export { VERIFY_RELEASE_REASONS, type VerifyReleaseReason } from '@gridmason/protocol';
