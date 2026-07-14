import { Command } from 'commander';
import type { IO } from '../io.js';
import { ExitCodeError } from '../exit.js';
import { runDev } from '../dev/index.js';
import { addGlobalOptions } from './global-options.js';

/** The resolved `dev` options commander hands the action. */
interface DevCommandOptions {
  port?: string;
  context?: string;
  proxy?: string;
  json?: boolean;
}

/**
 * `dev` — the local author loop (SPEC §4, FR-4/FR-5). Serves the widget's `entry`
 * for the Gridmason Dashboard's per-session `dev` sideload and a standalone
 * fixture harness, hot-reloads on source/manifest/fixture edits with live
 * manifest re-validation, and mounts the widget on the SDK fixture implementation
 * — `--context <name>` selects a named page-context preset, `--proxy <host-url>`
 * forwards SDK calls to a real host with capability checks still enforced. The
 * dev server is never a data backend: data comes from fixtures or the proxy.
 */
export function buildDev(io: IO): Command {
  const dev = addGlobalOptions(
    new Command('dev')
      .description('local dev server; serves the remote for the dashboard `dev` sideload')
      .option('--port <number>', 'port to listen on', '3000')
      .option('--context <name>', 'mount a named fixtures/contexts/<name>.json preset')
      .option('--proxy <host-url>', 'forward SDK calls to a real host (capability checks enforced)'),
  );
  dev.action(async (options: DevCommandOptions) => {
    const port = Number.parseInt(options.port ?? '3000', 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      io.err(`gridmason: --port must be an integer 0–65535, got "${options.port}"\n`);
      throw new ExitCodeError(1);
    }
    const code = await runDev(
      {
        port,
        context: options.context,
        proxy: options.proxy,
        json: options.json,
      },
      io,
    );
    if (code !== 0) {
      throw new ExitCodeError(code);
    }
  });
  return dev;
}
