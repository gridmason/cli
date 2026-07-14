import { Command } from 'commander';
import type { IO } from '../io.js';
import { notImplemented } from '../notice.js';
import { addGlobalOptions } from './global-options.js';

/**
 * The `widget` noun namespace — mirrors the manifest `kind`
 * (widget/plugin/page-type/layout). Its `init` subcommand scaffolds a project
 * (SPEC §3); the L-E1 `widget init` issue (#6) fills it in.
 */
export function buildWidget(io: IO): Command {
  const widget = new Command('widget').description(
    'author commands for a widget/plugin/page-type/layout project (mirrors the manifest `kind`)',
  );

  const init = addGlobalOptions(
    new Command('init')
      .argument('[name]', 'project directory / widget name (prompted when omitted)')
      .description('scaffold a widget/plugin/page-type/layout project'),
  );
  init.action(() => notImplemented('widget init', init.opts(), io));
  widget.addCommand(init);

  // `gridmason widget` with no subcommand: show the namespace help rather than
  // erroring, so an author discovers `init`.
  widget.action(() => io.out(widget.helpInformation()));

  return widget;
}
