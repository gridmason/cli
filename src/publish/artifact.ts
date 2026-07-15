/**
 * Assemble the **immutable, content-hashed artifact** a `publish` uploads (SPEC
 * §7): the manifest, its ES-module `entry`, and the widget's chunks + schemas +
 * docs, each addressed by the multihash-tagged SHA-256 of its exact bytes via
 * `@gridmason/protocol`'s `hashBytes` — so the CLI's `{ path → hash }` map matches
 * the registry's, which content-addresses the same bytes with the same hashing
 * (registry docs/api/publish.md, "Content addressing"). The CLI mints no crypto
 * here; hashing is delegated to the protocol so the digests match its vectors.
 *
 * The served file set is a small, documented convention (docs/publish.md), chosen
 * so a freshly scaffolded project (manifest + `src/entry.js` + `props.schema.json`
 * + `README.md`) assembles cleanly and no build junk (`package.json`, stories,
 * tests, fixtures, `node_modules`) is ever uploaded. Each part carries the
 * registry's `role` (`manifest | entry | chunk | schema | doc`) so the upload is
 * exactly one manifest + one entry plus the rest — the shape the Publish API
 * requires.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalize, hashBytes, type Manifest, type MultihashString } from '@gridmason/protocol';
import { isSafeRelativePath } from '../verify/index.js';

/** The manifest file a widget project is anchored on (matches `lint` / `dev`). */
const MANIFEST_FILE = 'manifest.json';

/** Extensions treated as JavaScript chunks (the ES-module graph the runtime loads). */
const CHUNK_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/** Directories never walked — dependencies, build output, VCS/CI, and dev-only inputs. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.github', 'fixtures']);

/** A per-file cap so a stray large/generated file cannot blow up an upload. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** The registry file roles (registry docs/api/publish.md). */
export type FileRole = 'manifest' | 'entry' | 'chunk' | 'schema' | 'doc';

/** One served artifact file: its project-relative path, role, and exact bytes. */
export interface ArtifactFile {
  /** Project-relative, forward-slashed path (e.g. `src/entry.js`). */
  readonly path: string;
  readonly role: FileRole;
  readonly bytes: Uint8Array;
  /** Multihash-tagged SHA-256 of {@link bytes} (`sha2-256:<hex>`), the content address. */
  readonly hash: MultihashString;
}

/** The assembled, content-hashed artifact ready to sign + upload. */
export interface Artifact {
  /** The manifest `tag` (the published, publisher-prefixed artifact name). */
  readonly tag: string;
  /** The manifest `version` (SemVer). */
  readonly version: string;
  /** Version-qualified artifact id, `<tag>@<version>` — the signature subject. */
  readonly id: string;
  /** The parsed manifest (validated by the lint gate before upload). */
  readonly manifest: Manifest;
  /** Every served file, manifest first, then entry, then chunks/schemas/docs. */
  readonly files: readonly ArtifactFile[];
  /** `{ path → content hash }` over the served files — the CLI's view of the registry's map. */
  readonly contentHashes: Readonly<Record<string, MultihashString>>;
  /** The signed source archive bytes (GW-D19 interim review input), content-hashed by the registry. */
  readonly sourceArchive: Uint8Array;
}

/** Why an artifact could not be assembled — machine consumers switch on the code. */
export type AssembleErrorCode =
  /** No `manifest.json` in the project directory (not a widget project). */
  | 'no-manifest'
  /** `manifest.json` is not valid JSON. */
  | 'invalid-json'
  /** The manifest lacks a string `tag` / `version` / `entry` (the fields upload requires). */
  | 'invalid-manifest'
  /** The manifest `entry` (or a `props`/declared file) is missing on disk. */
  | 'file-missing'
  /** A file could not be read. */
  | 'file-unreadable';

/** The outcome of {@link assembleArtifact}: the artifact, or a stable refusal. */
export type AssembleResult =
  | { readonly ok: true; readonly artifact: Artifact }
  | { readonly ok: false; readonly code: AssembleErrorCode; readonly message: string };

/** A plain, non-null, non-array object (for reading the untrusted manifest defensively). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Project-relative, forward-slashed path — the portable form a file part reports. */
function posixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** True for files that are dev-only and must never be published (stories, tests). */
function isDevOnly(rel: string): boolean {
  return /\.(stories|test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

/** Recursively collect project-relative paths under `dir` that pass `keep`, skipping dep/build dirs. */
async function walk(root: string, dir: string, keep: (rel: string) => boolean, into: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // no such directory — nothing to add
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, abs, keep, into);
    } else if (entry.isFile()) {
      const rel = posixRelative(root, abs);
      if (keep(rel)) into.add(rel);
    }
  }
}

/** Read one project file's exact bytes, failing closed with a stable code. */
async function readPart(root: string, rel: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; code: AssembleErrorCode; message: string }> {
  if (!isSafeRelativePath(rel)) {
    return { ok: false, code: 'invalid-manifest', message: `refusing an unsafe file path "${rel}" (absolute or traversal)` };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(root, rel));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'file-missing' : 'file-unreadable';
    return { ok: false, code, message: `could not read "${rel}": ${err instanceof Error ? err.message : String(err)}` };
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { ok: false, code: 'file-unreadable', message: `"${rel}" exceeds the ${MAX_FILE_BYTES}-byte per-file cap` };
  }
  return { ok: true, bytes };
}

/**
 * Assemble the content-hashed artifact from a widget project directory. Reads
 * `manifest.json`, then gathers, in role order:
 *
 * - **manifest** — `manifest.json`;
 * - **entry** — the file named by `manifest.entry`;
 * - **schema** — `manifest.props` (if set) and every `*.schema.json` at the
 *   project root or under `schemas/`;
 * - **chunk** — every `.js`/`.mjs`/`.cjs` under `src/` other than the entry
 *   (stories/tests excluded);
 * - **doc** — `README.md` at the root and every `*.md` under `docs/`.
 *
 * Fails closed and never throws: a missing/malformed manifest, a manifest missing
 * the fields the upload requires, or a missing/unreadable declared file each come
 * back as a stable {@link AssembleErrorCode}. This does not run lint — the caller
 * gates on `src/checks` before assembling — nor sign; it only produces the exact
 * immutable bytes the signature and the upload commit to.
 */
export async function assembleArtifact(root: string): Promise<AssembleResult> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, MANIFEST_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, code: 'no-manifest', message: `no ${MANIFEST_FILE} found in ${root} (not a widget project)` };
    }
    return { ok: false, code: 'file-unreadable', message: `could not read ${MANIFEST_FILE}: ${err instanceof Error ? err.message : String(err)}` };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    return { ok: false, code: 'invalid-json', message: `${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}` };
  }
  if (!isObject(manifest)) {
    return { ok: false, code: 'invalid-manifest', message: `${MANIFEST_FILE} must be a JSON object` };
  }

  const { tag, version, entry, props } = manifest;
  if (typeof tag !== 'string' || typeof version !== 'string' || typeof entry !== 'string') {
    return { ok: false, code: 'invalid-manifest', message: `${MANIFEST_FILE} must carry string "tag", "version", and "entry" fields to publish` };
  }

  // Gather the served paths in a stable, documented order: manifest, entry, then
  // schemas, chunks, docs (each sorted so the artifact is byte-deterministic).
  const schemaPaths = new Set<string>();
  if (typeof props === 'string' && props) schemaPaths.add(props);
  await walk(root, root, (rel) => !rel.includes('/') && rel.endsWith('.schema.json'), schemaPaths);
  await walk(root, path.join(root, 'schemas'), (rel) => rel.endsWith('.schema.json'), schemaPaths);

  const chunkPaths = new Set<string>();
  await walk(root, path.join(root, 'src'), (rel) => {
    const ext = path.extname(rel);
    return CHUNK_EXTENSIONS.has(ext) && rel !== entry && !isDevOnly(rel);
  }, chunkPaths);

  const docPaths = new Set<string>();
  await walk(root, root, (rel) => rel === 'README.md', docPaths);
  await walk(root, path.join(root, 'docs'), (rel) => rel.endsWith('.md'), docPaths);

  // Role-ordered, de-duplicated plan: manifest and entry are fixed; the rest are
  // sorted for determinism. The entry is removed from any other bucket.
  const plan: { rel: string; role: FileRole }[] = [
    { rel: MANIFEST_FILE, role: 'manifest' },
    { rel: entry, role: 'entry' },
    ...[...schemaPaths].filter((p) => p !== entry && p !== MANIFEST_FILE).sort().map((rel) => ({ rel, role: 'schema' as const })),
    ...[...chunkPaths].filter((p) => p !== entry && p !== MANIFEST_FILE).sort().map((rel) => ({ rel, role: 'chunk' as const })),
    ...[...docPaths].filter((p) => p !== entry && p !== MANIFEST_FILE).sort().map((rel) => ({ rel, role: 'doc' as const })),
  ];

  const files: ArtifactFile[] = [];
  const contentHashes: Record<string, MultihashString> = {};
  const seen = new Set<string>();
  for (const { rel, role } of plan) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const read = await readPart(root, rel);
    if (!read.ok) return read;
    const hash = await hashBytes(read.bytes);
    files.push({ path: rel, role, bytes: read.bytes, hash });
    contentHashes[rel] = hash;
  }

  // A deterministic source archive over the served bytes (base64 per path), sealed
  // with the protocol's canonicalization so re-assembling the same project yields
  // the identical archive bytes and the registry's content hash is reproducible.
  const sourceArchive = canonicalize({
    files: files.map((f) => ({ path: f.path, bytes: Buffer.from(f.bytes).toString('base64') })),
  });

  return {
    ok: true,
    artifact: {
      tag,
      version,
      id: `${tag}@${version}`,
      manifest: manifest as unknown as Manifest,
      files,
      contentHashes,
      sourceArchive,
    },
  };
}
