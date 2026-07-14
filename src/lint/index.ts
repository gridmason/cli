/**
 * `gridmason lint` orchestration (SPEC §5, FR-7): read the project's
 * `manifest.json`, run the shared checks module against it, and report — human
 * diagnostics on stderr, a `--json` report on stdout. The checks themselves live
 * in `src/checks` (the library the registry imports verbatim, SPEC §8); this
 * module is the CLI-only glue that builds the {@link CheckContext} from disk and
 * shapes the output.
 *
 * The `--json` shape here is deliberately minimal — the full structured report
 * (check-id → review-tier mapping) matures in #13. What is stable is that a
 * machine consumer gets a single JSON object on stdout and nothing else, and the
 * process exit code is `0` iff no check failed (so `publish` and CI fail closed).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IO } from '../io.js';
import { hasFailure, runChecks, type CheckContext, type CheckResult } from '../checks/index.js';

/** The manifest file a widget project is anchored on (matches `dev`). */
const MANIFEST_FILE = 'manifest.json';

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
    io.out(`${JSON.stringify({ command: 'lint', status: 'error', code, message })}\n`);
  } else {
    io.err(`gridmason: ${message}\n`);
  }
  return 1;
}

/**
 * Run `gridmason lint`. Reads `<path>/manifest.json`, runs every registered check
 * against it, reports the findings, and returns a process exit code: `0` when no
 * check failed, `1` when a check failed or the manifest could not be read.
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

  const ctx: CheckContext = { manifest, ...(opts.registry !== undefined ? { registry: opts.registry } : {}) };
  const results = runChecks(ctx);
  const failed = hasFailure(results);

  if (opts.json) {
    io.out(`${JSON.stringify({ command: 'lint', status: failed ? 'fail' : 'pass', results })}\n`);
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
