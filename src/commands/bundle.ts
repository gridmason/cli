import { Command } from 'commander';
import type { IO } from '../io.js';
import { notImplemented } from '../notice.js';
import { addGlobalOptions } from './global-options.js';

/**
 * `bundle export|inspect` — produce/inspect a signed offline `.gmb` bundle
 * (SPEC §2, Phase B); filled in by the L-E4 bundle issue (#18).
 */
export function buildBundle(io: IO): Command {
  const bundle = new Command('bundle').description('produce or inspect a signed offline .gmb bundle');

  const exportCmd = addGlobalOptions(
    new Command('export')
      .argument('[project]', 'project directory to bundle (defaults to the current directory)')
      .description('produce a signed offline .gmb bundle'),
  );
  exportCmd.action(() => notImplemented('bundle export', exportCmd.opts(), io));

  const inspect = addGlobalOptions(
    new Command('inspect')
      .argument('<bundle>', 'path to a .gmb bundle')
      .description('inspect the contents of a .gmb bundle'),
  );
  inspect.action(() => notImplemented('bundle inspect', inspect.opts(), io));

  bundle.addCommand(exportCmd);
  bundle.addCommand(inspect);

  // `gridmason bundle` with no subcommand: show help rather than erroring.
  bundle.action(() => io.out(bundle.helpInformation()));

  return bundle;
}
