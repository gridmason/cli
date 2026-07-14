import { Command } from 'commander';
import type { IO } from '../io.js';
import { ExitCodeError } from '../exit.js';
import { runLint } from '../lint/index.js';
import { addGlobalOptions, type GlobalOptions } from './global-options.js';

/**
 * `lint` — run the automated registry review checks locally (SPEC §5). Reads the
 * project's `manifest.json`, runs the shared checks module (the same code the
 * registry runs, SPEC §8), and reports: human diagnostics on stderr, a `--json`
 * report on stdout. Exits non-zero when a check fails. The manifest lint lands
 * here (#11); SDK-adherence (#12), the dependency-DAG check, and the full `--json`
 * tier mapping (#13) fill in the rest of the L-E2 surface.
 */
export function buildLint(io: IO): Command {
  const lint = addGlobalOptions(
    new Command('lint')
      .argument('[path]', 'widget project directory to lint (defaults to the current directory)')
      .description('run the exact automated registry review checks locally'),
  );
  lint.action(async (projectPath: string | undefined, options: GlobalOptions) => {
    const code = await runLint({ path: projectPath, registry: options.registry, json: options.json }, io);
    // `runLint` has already reported its own diagnostics; surface the exit code.
    if (code !== 0) {
      throw new ExitCodeError(code);
    }
  });
  return lint;
}
