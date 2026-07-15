/**
 * `gridmason lint` orchestration (SPEC §5, FR-7): read the project's
 * `manifest.json`, run the shared checks module against it, and report — human
 * diagnostics on stderr, a `--json` report on stdout. The checks themselves live
 * in `src/checks` (the library the registry imports verbatim, SPEC §8); this
 * module is the CLI-only glue that builds the {@link CheckContext} from disk and
 * shapes the output.
 *
 * The `--json` report serializes every check result and maps each to the registry
 * review tier its findings feed, with a `tiers` catalog for the SLAs (SPEC §5,
 * FR-7). Its shape is owned here and pinned by `schemas/lint-report.schema.json`
 * ({@link ./report.js}); a machine consumer gets a single JSON object on stdout
 * and nothing else, and the process exit code is `0` iff no check failed (so
 * `publish` and CI fail closed).
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { IO } from '../io.js';
import {
  HttpRegistryClient,
  hasFailure,
  runChecks,
  runRegistryChecks,
  type CheckContext,
  type CheckResult,
  type RegistryClient,
  type SourceFile,
} from '../checks/index.js';
import { buildLintErrorReport, buildLintReport } from './report.js';

/** The manifest file a widget project is anchored on (matches `dev`). */
const MANIFEST_FILE = 'manifest.json';

/** Extensions the static-analysis checks (#12) treat as widget source. */
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

/** Directories never walked for source (dependencies and build output, not authored code). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

/** A per-file cap so a stray large/generated file cannot blow up a lint run. */
const MAX_SOURCE_BYTES = 1_000_000;

/** A plain, non-null, non-array object (for reading the untrusted manifest defensively). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Project-relative, forward-slashed path — the portable form a finding reports. */
function posixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Read one source file into a {@link SourceFile}, or skip it (too big / unreadable). */
async function readSourceFile(root: string, abs: string, into: Map<string, SourceFile>): Promise<void> {
  const rel = posixRelative(root, abs);
  if (into.has(rel)) return;
  try {
    const contents = await readFile(abs, 'utf8');
    if (contents.length <= MAX_SOURCE_BYTES) {
      into.set(rel, { path: rel, contents });
    }
  } catch {
    // A file that races away or is unreadable simply is not analysed.
  }
}

/** Recursively gather source-extension files under `dir`, skipping deps/build output. */
async function walkSources(root: string, dir: string, into: Map<string, SourceFile>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // no such directory (e.g. a project with no `src/`) — nothing to add
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        await walkSources(root, abs, into);
      }
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      await readSourceFile(root, abs, into);
    }
  }
}

/**
 * Collect the widget's own source for the static-analysis checks (#12): every
 * source-extension file under `src/`, plus the manifest `entry` if it resolves to
 * a file outside that tree. This is the CLI's local proxy for what the registry
 * analyses in the uploaded artifact; a manifest-only context (no source found)
 * simply leaves those checks with nothing to flag.
 */
async function collectSourceFiles(root: string, manifest: unknown): Promise<SourceFile[]> {
  const files = new Map<string, SourceFile>();
  await walkSources(root, path.join(root, 'src'), files);
  const entry = isObject(manifest) && typeof manifest.entry === 'string' ? manifest.entry : undefined;
  if (entry !== undefined && SOURCE_EXTENSIONS.has(path.extname(entry))) {
    await readSourceFile(root, path.resolve(root, entry), files);
  }
  return [...files.values()];
}

/** Options `runLint` accepts — the command's flags plus a cwd test seam. */
export interface LintOptions {
  /** Project directory to lint (the command's `[path]` argument); defaults to cwd. */
  path?: string | undefined;
  /** Target registry (`--registry`), threaded into the check context. */
  registry?: string | undefined;
  /** Emit the machine-readable JSON report (`--json`). */
  json?: boolean | undefined;
  /** Base directory the `[path]` is resolved against; defaults to the process cwd. (test seam) */
  cwd?: string | undefined;
  /** The registry client the registry-aware checks read through; defaults to an {@link HttpRegistryClient} built from `registry`. (test seam) */
  registryClient?: RegistryClient | undefined;
}

/** Why `manifest.json` could not be read — machine consumers switch on the code. */
type LoadErrorCode = 'no-manifest' | 'invalid-json';

/** The status glyph for a finding, on stderr for humans. */
function glyph(status: CheckResult['status']): string {
  return status === 'pass' ? '✓' : status === 'warn' ? '!' : '✗';
}

/** Report that the manifest could not be loaded, honoring `--json`; returns exit 1. */
function reportLoadError(code: LoadErrorCode, message: string, io: IO, json: boolean | undefined): number {
  if (json) {
    io.out(`${JSON.stringify(buildLintErrorReport(code, message))}\n`);
  } else {
    io.err(`gridmason: ${message}\n`);
  }
  return 1;
}

/**
 * Run `gridmason lint`. Reads `<path>/manifest.json`, runs every registered check
 * against it — plus, when `--registry` is given, the registry-aware checks
 * (capability diff + server-validated DAG, SPEC §5 checks 3–4) — reports the
 * findings, and returns a process exit code: `0` when no check failed, `1` when a
 * check failed or the manifest could not be read.
 */
export async function runLint(opts: LintOptions, io: IO): Promise<number> {
  const root = path.resolve(opts.cwd ?? process.cwd(), opts.path ?? '.');
  const manifestPath = path.join(root, MANIFEST_FILE);

  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return reportLoadError('no-manifest', `no ${MANIFEST_FILE} found in ${root} (not a widget project)`, io, opts.json);
    }
    throw err;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    return reportLoadError('invalid-json', `${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`, io, opts.json);
  }

  const sourceFiles = await collectSourceFiles(root, manifest);
  const ctx: CheckContext = {
    manifest,
    sourceFiles,
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
  };
  const results = runChecks(ctx);
  // `--registry`: layer the registry-aware checks (capability diff + server DAG,
  // SPEC §5 checks 3–4) on top of the offline run, in report order after them.
  if (opts.registry !== undefined) {
    const client = opts.registryClient ?? new HttpRegistryClient(opts.registry);
    const registryResults = await runRegistryChecks({ manifest, registry: opts.registry, client });
    results.push(...registryResults);
  }
  const failed = hasFailure(results);

  if (opts.json) {
    io.out(`${JSON.stringify(buildLintReport(results, failed))}\n`);
  } else {
    for (const result of results) {
      io.err(`${glyph(result.status)} ${result.id}: ${result.message}\n`);
      if (result.hint !== undefined) {
        io.err(`    ↳ ${result.hint}\n`);
      }
    }
    const passed = results.filter((r) => r.status === 'pass').length;
    io.err(`\n${results.length} check result(s): ${passed} pass, ${results.length - passed} not-pass — ${failed ? 'FAIL' : 'OK'}\n`);
  }

  return failed ? 1 : 0;
}
