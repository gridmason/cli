import { verifyChunk, verifyOfflineBundle, type GmbBundle, type GmbFile, type MultihashString } from '@gridmason/protocol';
import { loadTrustConfig, type TrustConfigSource } from './trust-config.js';
import { formatVerdict, type VerdictRender } from './verdict.js';

/** Everything the offline `verify --offline <.gmb>` path touches, injected for testability. */
export interface VerifyOfflineDeps {
  /** Read the local `.gmb` file (and the trust config) as text. */
  readFile(path: string): Promise<string>;
  /** Read an environment variable (for the `GRIDMASON_TRUST_CONFIG` fallback). */
  env(name: string): string | undefined;
  /** Current time, epoch ms — threaded through to `verifyOfflineBundle` (the library holds no clock). */
  now(): number;
}

/** The parsed arguments an offline `verify` invocation supplies. */
export interface VerifyOfflineArgs {
  /** Path to the local `.gmb` bundle file. */
  readonly ref: string;
  /** `--trust-config <path>`, if given (takes precedence over the env fallback). */
  readonly trustConfig?: string;
  /** `--json`: emit a machine-readable verdict on stdout. */
  readonly json?: boolean;
}

/** The result of reading + shape-guarding a `.gmb` file. */
type BundleSourceResult =
  | { readonly ok: true; readonly bundle: GmbBundle }
  | { readonly ok: false; readonly code: 'artifact-unreadable' | 'artifact-malformed'; readonly message: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a `.gmb` bundle from disk into the {@link GmbBundle} structure
 * `verifyOfflineBundle` consumes. A `.gmb` is a self-contained JSON document (the
 * servable file bytes are base64 inside the payload), so this reads and parses it;
 * there is no separate archive/unzip step.
 *
 * Only the minimum structure needed to hand the object to the pure verifier is
 * guarded here — a non-object top level, a `contentHash` that is not a string, or
 * a missing `payload` — so the library's own stable verdicts survive (a
 * well-formed-JSON bundle whose seal is broken comes back as `bundle-hash-tampered`,
 * a malformed hash *string* as `bundle-malformed`, and so on, rather than a CLI
 * error). The `contentHash` string guard is load-bearing: the verifier reads it as
 * a string, so a non-string would throw rather than yield a verdict.
 */
async function resolveGmbBundle(deps: VerifyOfflineDeps, ref: string): Promise<BundleSourceResult> {
  let text: string;
  try {
    text = await deps.readFile(ref);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'artifact-unreadable', message: `could not read bundle ${ref}: ${detail}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, code: 'artifact-malformed', message: `bundle ${ref} is not valid JSON` };
  }
  if (!isObject(raw)) {
    return { ok: false, code: 'artifact-malformed', message: `bundle ${ref} must be a JSON object` };
  }
  if (typeof raw.contentHash !== 'string') {
    return { ok: false, code: 'artifact-malformed', message: `bundle ${ref} is missing a string contentHash` };
  }
  if (!isObject(raw.payload)) {
    return { ok: false, code: 'artifact-malformed', message: `bundle ${ref} is missing its payload` };
  }
  return { ok: true, bundle: raw as unknown as GmbBundle };
}

/**
 * The result of the packed-byte enforcement pass: either every listed file's
 * packed bytes verified, or one did not (its `path` is kept for internal logic
 * only — it is never surfaced in the verdict, honoring the no-tag-echo rule).
 */
export type PackedFilesResult = { readonly ok: true } | { readonly ok: false; readonly path: string };

/**
 * Confirm the bundle's *packed bytes* are the bytes the verified release map
 * commits to — the per-fetch check a host's Service Worker runs (`verifyChunk`),
 * done here at verify time over the self-contained archive.
 *
 * `verifyOfflineBundle` proves the release map is authentically signed and the
 * archive seal is intact, but it does **not** re-hash the packed file bytes
 * against that map (its docstring leaves that to the consumer). So a bundle could
 * carry, under an honestly-recomputed seal, packed bytes that do not hash to their
 * signed entry — a host would reject them at load. This runs `verifyChunk` for
 * every path in the verified `urlHashes`, requiring the bundle to pack that file
 * and its bytes to match, so "the reviewed hash is the runnable artifact" is
 * audited here rather than only at load (SPEC §6).
 */
export async function enforcePackedFiles(
  bundle: GmbBundle,
  urlHashes: ReadonlyMap<string, MultihashString>,
): Promise<PackedFilesResult> {
  const payload = bundle.payload;
  const packed = new Map<string, GmbFile>();
  for (const file of [payload.entry, ...payload.chunks, ...payload.schemas, ...payload.docs]) {
    packed.set(file.path, file);
  }
  for (const [path, expected] of urlHashes) {
    const file = packed.get(path);
    if (!file) return { ok: false, path };
    const bytes = new Uint8Array(Buffer.from(file.bytes, 'base64'));
    if (!(await verifyChunk(bytes, expected))) return { ok: false, path };
  }
  return { ok: true };
}

/**
 * Run the offline `verify --offline <.gmb>` flow and return a rendered verdict.
 * Mirrors the online path's shape and reuses its seams — {@link loadTrustConfig}
 * (blind-root refusal, SPEC §4.4, resolved before the bundle is read) and
 * {@link formatVerdict} — and delegates the whole air-gapped decision to
 * `@gridmason/protocol`'s `verifyOfflineBundle`: the identical `verifyRelease`
 * chain plus the bundle archive-integrity gate, against pinned roots only, no
 * network. On a clean chain it additionally enforces the packed bytes with
 * `verifyChunk` ({@link enforcePackedFiles}); a packed byte that does not match
 * its verified hash is surfaced as the stable `content-hash-mismatch` reason.
 */
export async function runVerifyOffline(deps: VerifyOfflineDeps, args: VerifyOfflineArgs): Promise<VerdictRender> {
  const envConfig = deps.env('GRIDMASON_TRUST_CONFIG');
  const source: TrustConfigSource = {
    ...(args.trustConfig !== undefined ? { path: args.trustConfig } : {}),
    ...(envConfig !== undefined ? { env: envConfig } : {}),
  };
  const trust = await loadTrustConfig({ readFile: deps.readFile }, source);
  if (!trust.ok) {
    return formatVerdict({ kind: 'error', code: trust.code, message: trust.message }, args);
  }

  const resolved = await resolveGmbBundle(deps, args.ref);
  if (!resolved.ok) {
    return formatVerdict({ kind: 'error', code: resolved.code, message: resolved.message }, args);
  }

  const result = await verifyOfflineBundle({
    bundle: resolved.bundle,
    pins: trust.config.pins,
    publisherCARoots: trust.config.publisherCARoots,
    countersignRoots: trust.config.countersignRoots,
    logPublicKey: trust.config.logPublicKey,
    now: deps.now(),
  });

  if (!result.ok) {
    return formatVerdict({ kind: 'refused', reason: result.reason }, args);
  }

  const packed = await enforcePackedFiles(resolved.bundle, result.urlHashes);
  if (!packed.ok) {
    return formatVerdict({ kind: 'refused', reason: 'content-hash-mismatch' }, args);
  }

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
