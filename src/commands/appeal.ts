import { Command } from 'commander';
import type { IO } from '../io.js';
import { notImplemented } from '../notice.js';
import { addGlobalOptions } from './global-options.js';

/** `appeal` — request a second reviewer (SPEC §7, Phase B); filled in by the L-E3 publish issue (#17). */
export function buildAppeal(io: IO): Command {
  const appeal = addGlobalOptions(
    new Command('appeal')
      .argument('<artifact>', 'the artifact to appeal for a second review')
      .description('request a second reviewer for a rejected artifact'),
  );
  appeal.action(() => notImplemented('appeal', appeal.opts(), io));
  return appeal;
}
