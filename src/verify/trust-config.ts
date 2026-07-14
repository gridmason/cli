import type { LogPublicKey, TrustRootPin } from '@gridmason/protocol';

/**
 * The out-of-band trust material a host would ship, supplied to the CLI so that
 * `verify` runs the *same* pinned-root check a host runs (SPEC §4.4, §8). The
 * artifact URL delivers the release, envelope, trust-root document, and log entry
 * (all untrusted network input); these roots and keys are what those documents
 * are believed *against*, and they are only ever pinned/config-supplied — never
 * fetched. The trust-root *document* is gated against {@link pins}; the root
 * *keys* below are the operator's pinned material.
 */
export interface TrustConfig {
  /** Operator pins authorizing a registry's countersign roots (the blind-root gate). */
  readonly pins: readonly TrustRootPin[];
  /** Pinned publisher CA root public keys (SPKI DER) that may issue publisher leaf certs. */
  readonly publisherCARoots: readonly Uint8Array[];
  /** Pinned registry countersign root public keys (SPKI DER); also the rotation cross-signers. */
  readonly countersignRoots: readonly Uint8Array[];
  /** The pinned transparency-log checkpoint key the inclusion proof is checked against. */
  readonly logPublicKey: LogPublicKey;
}

/**
 * The JSON shape of a trust-config file. Binary keys (SPKI DER roots, the 32-byte
 * Ed25519 log key) are carried base64-encoded; {@link loadTrustConfig} decodes
 * them to the `Uint8Array` the protocol library expects.
 */
interface TrustConfigFile {
  pins?: unknown;
  publisherCARoots?: unknown;
  countersignRoots?: unknown;
  logPublicKey?: unknown;
}

/**
 * The result of resolving trust configuration: the parsed {@link TrustConfig}, or
 * a stable failure. `no-trust-config` is the blind-root refusal (no source, or a
 * source that pins nothing); `trust-config-invalid` is a present-but-malformed
 * config.
 */
export type TrustConfigResult =
  | { readonly ok: true; readonly config: TrustConfig }
  | { readonly ok: false; readonly code: 'no-trust-config' | 'trust-config-invalid'; readonly message: string };

/** Where the trust config was found — a `--trust-config <path>` or the env fallback. */
export interface TrustConfigSource {
  /** `--trust-config <path>`, if given. */
  readonly path?: string;
  /** `GRIDMASON_TRUST_CONFIG` value, if set. */
  readonly env?: string;
}

/** The dependencies {@link loadTrustConfig} needs — injected so it is testable without a filesystem. */
export interface TrustConfigDeps {
  readFile(path: string): Promise<string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decode a base64 string to bytes, or `undefined` if it is not a valid base64 string. */
function decodeBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const buf = Buffer.from(value, 'base64');
    // Buffer.from is lenient (drops invalid chars); re-encode to reject junk.
    if (buf.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return undefined;
    return new Uint8Array(buf);
  } catch {
    return undefined;
  }
}

function parsePins(value: unknown): readonly TrustRootPin[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pins: TrustRootPin[] = [];
  for (const entry of value) {
    if (!isObject(entry)) return undefined;
    const { registryId, root, channel } = entry;
    if (typeof registryId !== 'string' || typeof root !== 'string') return undefined;
    if (channel !== 'build-time' && channel !== 'deploy-time') return undefined;
    pins.push({ registryId, root, channel });
  }
  return pins;
}

function parseRoots(value: unknown): readonly Uint8Array[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const roots: Uint8Array[] = [];
  for (const entry of value) {
    const bytes = decodeBase64(entry);
    if (!bytes) return undefined;
    roots.push(bytes);
  }
  return roots;
}

function parseLogPublicKey(value: unknown): LogPublicKey | undefined {
  if (!isObject(value)) return undefined;
  const { name, key } = value;
  if (typeof name !== 'string') return undefined;
  const bytes = decodeBase64(key);
  if (!bytes) return undefined;
  return { name, key: bytes };
}

/**
 * Resolve the trust configuration the online `verify` path runs against. Reads
 * `--trust-config <path>` if given, else the `GRIDMASON_TRUST_CONFIG` env var; a
 * relative env value is treated as a file path too.
 *
 * Returns `no-trust-config` — the SPEC §4.4 blind-root refusal — when there is no
 * source at all, or when a well-formed source pins nothing (`pins` empty): with
 * nothing pinned there is no root to believe the artifact against, and the CLI
 * refuses to proceed rather than trust a network-supplied root. Returns
 * `trust-config-invalid` when a source exists but does not read/parse.
 */
export async function loadTrustConfig(
  deps: TrustConfigDeps,
  source: TrustConfigSource,
): Promise<TrustConfigResult> {
  const path = source.path ?? source.env;
  if (!path) {
    return {
      ok: false,
      code: 'no-trust-config',
      message:
        'no trust roots configured — pass --trust-config <path> or set GRIDMASON_TRUST_CONFIG; ' +
        'verify never trusts a root fetched blind (SPEC §4.4)',
    };
  }

  let text: string;
  try {
    text = await deps.readFile(path);
  } catch {
    return { ok: false, code: 'trust-config-invalid', message: `could not read trust config: ${path}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, code: 'trust-config-invalid', message: `trust config is not valid JSON: ${path}` };
  }
  if (!isObject(raw)) {
    return { ok: false, code: 'trust-config-invalid', message: `trust config must be a JSON object: ${path}` };
  }

  const file = raw as TrustConfigFile;
  const pins = parsePins(file.pins);
  const publisherCARoots = parseRoots(file.publisherCARoots);
  const countersignRoots = parseRoots(file.countersignRoots);
  const logPublicKey = parseLogPublicKey(file.logPublicKey);
  if (!pins || !publisherCARoots || !countersignRoots || !logPublicKey) {
    return {
      ok: false,
      code: 'trust-config-invalid',
      message:
        `trust config is malformed: ${path} — expected { pins: [{registryId,root,channel}], ` +
        'publisherCARoots?: base64[], countersignRoots?: base64[], logPublicKey: {name, key: base64} }',
    };
  }

  if (pins.length === 0) {
    return {
      ok: false,
      code: 'no-trust-config',
      message: 'trust config pins nothing — at least one pin is required; verify never trusts a blind root (SPEC §4.4)',
    };
  }

  return { ok: true, config: { pins, publisherCARoots, countersignRoots, logPublicKey } };
}
