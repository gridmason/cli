import { Command } from 'commander';
import type { IO } from '../io.js';
import { ExitCodeError } from '../exit.js';
import { runInit } from '../init/index.js';
import { addGlobalOptions } from './global-options.js';

/** The shape of the resolved `widget init` options commander hands the action. */
interface InitCommandOptions {
  publisher?: string;
  kind: string;
  framework: string;
  json?: boolean;
}

/**
 * The `widget` noun namespace — mirrors the manifest `kind`
 * (widget/plugin/page-type/layout). Its `init` subcommand scaffolds a project
 * (SPEC §3): a publisher-prefixed manifest stub, the framework `entry`, a props
 * schema, a thumbnail placeholder, a story stub, a CI workflow, and seeded
 * fixtures. Prompts for anything not supplied as a flag when run interactively.
 */
export function buildWidget(io: IO): Command {
  const widget = new Command('widget').description(
    'author commands for a widget/plugin/page-type/layout project (mirrors the manifest `kind`)',
  );

  const init = addGlobalOptions(
    new Command('init')
      .argument('[name]', 'project directory / widget name (prompted when omitted)')
      .option('--publisher <prefix>', 'publisher namespace prefix for the tag (prompted when omitted)')
      .option('--kind <kind>', 'artifact kind: widget | plugin | page-type | layout', 'widget')
      .option('--framework <name>', 'starter framework: vanilla | react | vue', 'vanilla')
      .description('scaffold a widget/plugin/page-type/layout project'),
  );
  init.action(async (name: string | undefined, options: InitCommandOptions) => {
    const code = await runInit(
      {
        name,
        publisher: options.publisher,
        kind: options.kind,
        framework: options.framework,
        json: options.json,
      },
      io,
    );
    // `runInit` has already reported its own diagnostics; surface the exit code.
    if (code !== 0) {
      throw new ExitCodeError(code);
    }
  });
  widget.addCommand(init);

  // `gridmason widget` with no subcommand: show the namespace help rather than
  // erroring, so an author discovers `init`.
  widget.action(() => io.out(widget.helpInformation()));

  return widget;
}
