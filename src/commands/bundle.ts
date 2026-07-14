import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import type { IO } from '../io.js';
import { ExitCodeError } from '../exit.js';
import { runBundleExport, runBundleInspect } from '../bundle/index.js';
import { addGlobalOptions, type GlobalOptions } from './global-options.js';

interface ExportOptions extends GlobalOptions {
  release?: string;
  output?: string;
  producedBy?: string;
  trustConfig?: string;
}

interface InspectOptions extends GlobalOptions {
  trustConfig?: string;
}

/** Real filesystem/network IO for the bundle engines (injected as pure functions so the engines stay testable). */
function fsDeps() {
  return {
    readText: (file: string) => readFile(file, 'utf8'),
    readBytes: async (file: string): Promise<Uint8Array> => new Uint8Array(await readFile(file)),
    fetchText: async (url: string): Promise<string> => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return response.text();
    },
    writeText: (file: string, data: string) => writeFile(file, data, 'utf8'),
    env: (name: string) => process.env[name],
    now: () => Date.now(),
  };
}

/**
 * `bundle export|inspect` — produce/inspect a signed offline `.gmb` bundle
 * (SPEC §2, FR-13, Phase B). `export` repackages an already-signed release (from
 * `--release`, a local file or registry URL — the CLI signs nothing) plus the
 * project's servable bytes into a self-sealing archive and self-verifies it through
 * the offline chain; `inspect` reads one back and prints its contents and verdict.
 */
export function buildBundle(io: IO): Command {
  const bundle = new Command('bundle').description('produce or inspect a signed offline .gmb bundle');

  const exportCmd = addGlobalOptions(
    new Command('export')
      .argument('[project]', 'project directory to bundle (defaults to the current directory)', '.')
      .requiredOption(
        '--release <ref>',
        'signed release document to embed ({ release, envelope, trustRoot, logEntry }): a local path or an http(s):// registry URL',
      )
      .option('--output <path>', 'output .gmb path (defaults to <artifact>.gmb)')
      .option('--produced-by <id>', 'provenance stamp (defaults to the embedded trust root registry id)')
      .option(
        '--trust-config <path>',
        'pinned trust roots for the full-chain self-check; falls back to GRIDMASON_TRUST_CONFIG',
      )
      .description('produce a signed offline .gmb bundle'),
  );
  exportCmd.action(async (project: string) => {
    const opts = exportCmd.opts<ExportOptions>();
    const render = await runBundleExport(fsDeps(), {
      project,
      release: opts.release as string,
      ...(opts.output !== undefined ? { output: opts.output } : {}),
      ...(opts.producedBy !== undefined ? { producedBy: opts.producedBy } : {}),
      ...(opts.trustConfig !== undefined ? { trustConfig: opts.trustConfig } : {}),
      ...(opts.json ? { json: true } : {}),
    });
    if (render.stdout) io.out(render.stdout);
    if (render.stderr) io.err(render.stderr);
    if (render.exitCode !== 0) throw new ExitCodeError(render.exitCode);
  });

  const inspect = addGlobalOptions(
    new Command('inspect')
      .argument('<bundle>', 'path to a .gmb bundle')
      .option(
        '--trust-config <path>',
        'pinned trust roots to render the offline verdict; falls back to GRIDMASON_TRUST_CONFIG',
      )
      .description('inspect the contents and offline verdict of a .gmb bundle'),
  );
  inspect.action(async (bundlePath: string) => {
    const opts = inspect.opts<InspectOptions>();
    const render = await runBundleInspect(fsDeps(), {
      ref: bundlePath,
      ...(opts.trustConfig !== undefined ? { trustConfig: opts.trustConfig } : {}),
      ...(opts.json ? { json: true } : {}),
    });
    if (render.stdout) io.out(render.stdout);
    if (render.stderr) io.err(render.stderr);
    if (render.exitCode !== 0) throw new ExitCodeError(render.exitCode);
  });

  bundle.addCommand(exportCmd);
  bundle.addCommand(inspect);

  // `gridmason bundle` with no subcommand: show help rather than erroring.
  bundle.action(() => io.out(bundle.helpInformation()));

  return bundle;
}
