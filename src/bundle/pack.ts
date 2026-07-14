import { canonicalize, hashBytes } from '@gridmason/protocol';
import type {
  GmbBundle,
  GmbFile,
  GmbPayload,
  Manifest,
  ReleaseDoc,
  SignatureEnvelope,
  TransparencyLogEntry,
} from '@gridmason/protocol';
import { isSafeRelativePath } from '../verify/index.js';

/**
 * The `.gmb` **writer** (SPEC §2, FR-13) — the inverse of the offline reader in
 * `src/verify/bundle.ts`. It takes the four signed-chain documents a prior
 * `publish`/registry produced (release, envelope, log entry, trust root — the CLI
 * mints none of them; it holds no bespoke crypto, SPEC §8) plus the project's
 * servable file bytes, and packs them into a single self-sealing archive.
 *
 * Nothing here signs. A `.gmb` is a *repackaging* of an already-signed release for
 * the air gap: the cryptographic trust travels inside the embedded chain, and the
 * bundle-level {@link GmbBundle.contentHash} is only an integrity seal over the
 * whole payload (protocol §4.5). The producer cannot vouch for itself — the offline
 * verifier believes the embedded trust root only when it matches an operator pin.
 */

/** The four signed-chain documents a bundle carries, exactly as the online `verify` source delivers them. */
export interface SignedRelease {
  readonly release: ReleaseDoc;
  readonly envelope: SignatureEnvelope;
  /** Untrusted network/document value — the offline verifier gates it against the operator's pins. */
  readonly trustRoot: unknown;
  readonly logEntry: TransparencyLogEntry;
}

/** Everything {@link assembleBundle} needs; the servable bytes are pulled lazily so the caller owns the fs. */
export interface AssembleInput {
  /** The project manifest — its `entry` names which packed file is the ES-module entry. */
  readonly manifest: Manifest;
  /** The signed chain to embed (release map + envelope + log inclusion proof + trust root). */
  readonly signed: SignedRelease;
  /**
   * Read the exact served bytes for one release-map path, relative to the project.
   * Throws if the file is absent — the caller maps that to a `file-unreadable` refusal.
   */
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  /** Provenance stamp for {@link GmbBundle.producedBy} — audit metadata only, never a trust anchor. */
  readonly producedBy: string;
}

/** Stable, switchable reasons {@link assembleBundle} refuses to produce a bundle. Never echo a hostile path. */
export type AssembleErrorCode =
  /** The signed release lists no files — there is nothing to pack. */
  | 'release-empty'
  /** `manifest.entry` is not one of the signed release's files, so the bundle would have no verifiable entry. */
  | 'entry-not-in-release'
  /** A release-map path is absolute or contains a `..` traversal segment (rejected before any read). */
  | 'unsafe-path'
  /** A file the signed release commits to could not be read from the project. */
  | 'file-unreadable'
  /** The assembled payload could not be canonicalized/hashed to seal the archive. */
  | 'seal-failed';

/** The outcome of {@link assembleBundle}: a sealed bundle, or a stable refusal. */
export type AssembleResult =
  | { readonly ok: true; readonly bundle: GmbBundle; readonly fileCount: number }
  | { readonly ok: false; readonly code: AssembleErrorCode; readonly message: string };

/** The wire major the offline verifier speaks (`GmbBundle.formatVersion`); see protocol §4.5. */
const GMB_FORMAT_VERSION = '1.0';

/**
 * Which {@link GmbPayload} section a servable path belongs to. The signed release
 * map is authoritative for *which* files ship and their hashes, but it does not
 * tag their kind, so the split is derived here: the manifest `entry` is the entry
 * module, the settings-schema `props` and any `*.schema.json` are schemas, `*.md`
 * are docs, and everything else is a code chunk.
 *
 * This categorization is the CLI's own convention (documented in docs/bundle.md);
 * it affects only how `inspect` groups files and the canonical byte order under the
 * seal — never verification, which addresses every file uniformly by path through
 * the release map. A future registry-authoritative categorization would slot in
 * here without touching the verifier.
 */
function classify(path: string, manifest: Manifest): keyof Pick<GmbPayload, 'chunks' | 'schemas' | 'docs'> | 'entry' {
  if (path === manifest.entry) return 'entry';
  if (path === manifest.props || path.endsWith('.schema.json')) return 'schemas';
  if (path.endsWith('.md')) return 'docs';
  return 'chunks';
}

/**
 * Assemble and **seal** a `.gmb` from a manifest, a signed release chain, and the
 * project's servable bytes. Reads every path the signed release commits to (so the
 * bundle carries exactly the signed file set), packs each as base64 under its
 * classified section, then computes the bundle content hash over the canonicalized
 * payload (RFC-8785, the same subject the offline verifier re-derives).
 *
 * Fails closed and never throws: a release with no files, a `manifest.entry` the
 * release does not list, an unsafe path, a missing file, or a seal failure each
 * come back as a stable {@link AssembleErrorCode}. The produced bundle is *not*
 * self-verified here — that is the export orchestrator's job (it runs the bundle
 * back through the offline chain) so this stays a pure, synchronous-shaped packer.
 */
export async function assembleBundle(input: AssembleInput): Promise<AssembleResult> {
  const { manifest, signed, readBytes, producedBy } = input;
  const paths = Object.keys(signed.release.files ?? {});
  if (paths.length === 0) {
    return { ok: false, code: 'release-empty', message: 'the signed release lists no files to pack' };
  }
  if (!paths.includes(manifest.entry)) {
    return {
      ok: false,
      code: 'entry-not-in-release',
      message: `manifest entry "${manifest.entry}" is not among the signed release's files`,
    };
  }

  let entry: GmbFile | undefined;
  const chunks: GmbFile[] = [];
  const schemas: GmbFile[] = [];
  const docs: GmbFile[] = [];

  for (const path of paths) {
    if (!isSafeRelativePath(path)) {
      return { ok: false, code: 'unsafe-path', message: 'the signed release lists an unsafe file path (absolute or traversal)' };
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBytes(path);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 'file-unreadable', message: `could not read a released file from the project: ${detail}` };
    }
    const file: GmbFile = { path, bytes: Buffer.from(bytes).toString('base64') };
    switch (classify(path, manifest)) {
      case 'entry':
        entry = file;
        break;
      case 'schemas':
        schemas.push(file);
        break;
      case 'docs':
        docs.push(file);
        break;
      case 'chunks':
        chunks.push(file);
        break;
    }
  }

  // `entry` is guaranteed set: manifest.entry is in `paths` and classifies to 'entry'.
  const payload: GmbPayload = {
    manifest,
    release: signed.release,
    envelope: signed.envelope,
    logEntry: signed.logEntry,
    trustRoot: signed.trustRoot as GmbPayload['trustRoot'],
    entry: entry as GmbFile,
    chunks,
    schemas,
    docs,
  };

  let contentHash;
  try {
    contentHash = await hashBytes(canonicalize(payload));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'seal-failed', message: `could not seal the bundle: ${detail}` };
  }

  const bundle: GmbBundle = {
    formatVersion: GMB_FORMAT_VERSION,
    producedBy,
    contentHash,
    payload,
  };
  return { ok: true, bundle, fileCount: paths.length };
}
