import { verifyRelease } from '@gridmason/protocol';
import { loadTrustConfig, type TrustConfigSource } from './trust-config.js';
import { resolveVerificationInput } from './source.js';
import { formatVerdict, type VerdictRender } from './verdict.js';

/** Everything the online `verify` path touches, injected so the whole run is drivable in a test. */
export interface VerifyRunDeps {
  /** Fetch a remote artifact reference as text. */
  fetchText(url: string): Promise<string>;
  /** Read a local file (artifact source or trust config) as text. */
  readFile(path: string): Promise<string>;
  /** Read an environment variable (for the `GRIDMASON_TRUST_CONFIG` fallback). */
  env(name: string): string | undefined;
  /** Current time, epoch ms — threaded through to `verifyRelease` (the library holds no clock). */
  now(): number;
}

/** The parsed arguments a `verify` invocation supplies to the run. */
export interface VerifyRunArgs {
  /** The artifact reference: an `http(s)://` URL or a local verification-input file path. */
  readonly ref: string;
  /** `--trust-config <path>`, if given (takes precedence over the env fallback). */
  readonly trustConfig?: string;
  /** `--json`: emit a machine-readable verdict on stdout. */
  readonly json?: boolean;
}

/**
 * Run the online `verify` flow and return a rendered verdict (exit code + stream
 * text). The CLI's role is thin and deliberate: resolve the untrusted artifact
 * inputs, resolve the operator's pinned trust roots (refusing to proceed on a
 * blind/unpinned root, SPEC §4.4), then delegate *every* cryptographic and trust
 * decision to `@gridmason/protocol`'s `verifyRelease` (SPEC §8 — the CLI holds no
 * bespoke crypto). The library's stable {@link import('@gridmason/protocol').VerifyReleaseReason}
 * is surfaced verbatim; the CLI adds only operational failures (unreadable
 * artifact, blind config) that mean no verdict was reached.
 *
 * Order matters: trust config is resolved *before* the artifact is fetched, so a
 * blind configuration fails closed without any network work.
 */
export async function runVerify(deps: VerifyRunDeps, args: VerifyRunArgs): Promise<VerdictRender> {
  const envConfig = deps.env('GRIDMASON_TRUST_CONFIG');
  const source: TrustConfigSource = {
    ...(args.trustConfig !== undefined ? { path: args.trustConfig } : {}),
    ...(envConfig !== undefined ? { env: envConfig } : {}),
  };
  const trust = await loadTrustConfig({ readFile: deps.readFile }, source);
  if (!trust.ok) {
    return formatVerdict({ kind: 'error', code: trust.code, message: trust.message }, args);
  }

  const resolved = await resolveVerificationInput(
    { fetchText: deps.fetchText, readFile: deps.readFile },
    args.ref,
  );
  if (!resolved.ok) {
    return formatVerdict({ kind: 'error', code: resolved.code, message: resolved.message }, args);
  }

  const result = await verifyRelease({
    release: resolved.input.release,
    envelope: resolved.input.envelope,
    trustRoot: resolved.input.trustRoot,
    logEntry: resolved.input.logEntry,
    pins: trust.config.pins,
    publisherCARoots: trust.config.publisherCARoots,
    countersignRoots: trust.config.countersignRoots,
    logPublicKey: trust.config.logPublicKey,
    now: deps.now(),
  });

  if (result.ok) {
    return formatVerdict(
      {
        kind: 'verified',
        artifact: result.subject.artifact,
        issuer: result.issuer,
        subject: result.subject,
        fileCount: result.urlHashes.size,
      },
      args,
    );
  }
  return formatVerdict({ kind: 'refused', reason: result.reason }, args);
}
