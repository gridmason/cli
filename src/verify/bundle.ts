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
 * Per-file decoded-size cap (bytes) for a bundle's packed files. A `.gmb` is
 * untrusted input read *before* any verification, and the pure verifier
 * canonicalizes the whole payload (every packed base64 string) to compute the
 * archive hash — so an adversarial bundle packing huge files could exhaust memory
 * before the protocol ever rules. The cap is enforced up front against the base64
 * string length (a cheap, no-decode upper bound: decoded ≤ ⌈len·3/4⌉ bytes).
 */
export const MAX_BUNDLE_FILE_BYTES = 8 * 1024 * 1024;

/** Total decoded-size cap (bytes) across every packed file in a bundle. See {@link MAX_BUNDLE_FILE_BYTES}. */
export const MAX_BUNDLE_TOTAL_BYTES = 64 * 1024 * 1024;

/** Cheap upper bound on the decoded byte length of a base64 string, without decoding it. */
function decodedUpperBound(base64: string): number {
  return Math.ceil((base64.length * 3) / 4);
}

/**
 * Whether `path` is a safe relative servable key — not absolute, no `..`
 * traversal segment, no NUL, non-empty. Bundle file paths are untrusted and end
 * up as keys of the verified `url → hash` map a downstream consumer may resolve
 * against a filesystem/URL base, so a traversal- or absolute-shaped path is
 * rejected at the structural guard (never handed onward), independent of the fact
 * that verification itself writes nothing.
 */
function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes('\0')) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false; // Windows drive-absolute (e.g. C:\)
  return !path.split(/[/\\]/).includes('..');
}

/** Narrow an untrusted value to a {@link GmbFile} (object with string `path` + `bytes`), else `undefined`. */
function toFile(value: unknown): GmbFile | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.path !== 'string' || typeof value.bytes !== 'string') return undefined;
  return { path: value.path, bytes: value.bytes };
}

/**
 * Safely gather every packed file (`entry` + `chunks` + `schemas` + `docs`) from a
 * payload, guarding each section so a malformed/omitted section coerces to nothing
 * rather than throwing on a spread. Used by both the structural validation and the
 * packed-byte enforcement, so neither can be tripped by a missing section.
 */
function collectPackedFiles(payload: unknown): GmbFile[] {
  const out: GmbFile[] = [];
  if (!isObject(payload)) return out;
  const entry = toFile(payload.entry);
  if (entry) out.push(entry);
  for (const section of [payload.chunks, payload.schemas, payload.docs]) {
    if (!Array.isArray(section)) continue;
    for (const item of section) {
      const file = toFile(item);
      if (file) out.push(file);
    }
  }
  return out;
}

/**
 * Validate a bundle payload's file sections before the payload reaches the pure
 * verifier: `entry` must be a well-formed file and `chunks`/`schemas`/`docs` must
 * each be arrays of well-formed files (a missing or non-array section is
 * malformed); every path must be a safe relative key; and the packed bytes must
 * stay within the per-file and total size caps. Returns a message on the first
 * failure. Sizes and hostile paths are never echoed. Exported for direct testing.
 */
export function validatePayloadFiles(
  payload: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  if (toFile(payload.entry) === undefined) {
    return { ok: false, message: 'payload.entry must be a file with string path and bytes' };
  }
  for (const section of ['chunks', 'schemas', 'docs'] as const) {
    const value = payload[section];
    if (!Array.isArray(value)) {
      return { ok: false, message: `payload.${section} must be an array of files` };
    }
    for (const item of value) {
      if (toFile(item) === undefined) {
        return { ok: false, message: `payload.${section} entries must be files with string path and bytes` };
      }
    }
  }

  let total = 0;
  for (const file of collectPackedFiles(payload)) {
    if (!isSafeRelativePath(file.path)) {
      return { ok: false, message: 'payload contains an unsafe file path (absolute or traversal)' };
    }
    const size = decodedUpperBound(file.bytes);
    if (size > MAX_BUNDLE_FILE_BYTES) {
      return { ok: false, message: `a packed file exceeds the ${MAX_BUNDLE_FILE_BYTES}-byte per-file cap` };
    }
    total += size;
    if (total > MAX_BUNDLE_TOTAL_BYTES) {
      return { ok: false, message: `packed files exceed the ${MAX_BUNDLE_TOTAL_BYTES}-byte total cap` };
    }
  }
  return { ok: true };
}

/**
 * Read a `.gmb` bundle from disk into the {@link GmbBundle} structure
 * `verifyOfflineBundle` consumes. A `.gmb` is a self-contained JSON document (the
 * servable file bytes are base64 inside the payload), so this reads and parses it;
 * there is no separate archive/unzip step.
 *
 * The guard is deliberately narrow but covers what an *adversarial* bundle could
 * do before the pure verifier runs — the verifier canonicalizes the whole payload
 * to compute the archive hash, so a hostile bundle must not be able to throw or
 * exhaust memory in transit. It checks: a non-object top level, a `contentHash`
 * that is not a string (the verifier reads it as a string and would otherwise
 * throw), a missing `payload`, malformed/omitted file sections (a spread over a
 * non-array would throw), unsafe file paths (absolute/`..`), and the per-file /
 * total size caps ({@link validatePayloadFiles}). Everything else — a broken seal,
 * a malformed hash string, a bad signature — flows through so the library's own
 * stable verdicts (`bundle-hash-tampered`, `bundle-malformed`, the chain reasons)
 * survive rather than becoming a CLI error.
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
  const files = validatePayloadFiles(raw.payload);
  if (!files.ok) {
    return { ok: false, code: 'artifact-malformed', message: `bundle ${ref}: ${files.message}` };
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
 *
 * Defensive on its own: it gathers files through the section-guarding collector
 * (never spreads a possibly-non-array section) and re-checks the per-file size cap
 * before decoding, so it is safe even if called directly on an unvalidated bundle.
 * In the normal flow {@link resolveGmbBundle} has already enforced both.
 */
export async function enforcePackedFiles(
  bundle: GmbBundle,
  urlHashes: ReadonlyMap<string, MultihashString>,
): Promise<PackedFilesResult> {
  const packed = new Map<string, GmbFile>();
  for (const file of collectPackedFiles(bundle.payload)) {
    packed.set(file.path, file);
  }
  for (const [path, expected] of urlHashes) {
    const file = packed.get(path);
    if (!file) return { ok: false, path };
    if (decodedUpperBound(file.bytes) > MAX_BUNDLE_FILE_BYTES) return { ok: false, path };
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
