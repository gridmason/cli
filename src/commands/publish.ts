import { Command } from 'commander';
import type { IO } from '../io.js';
import { notImplemented } from '../notice.js';
import { addGlobalOptions } from './global-options.js';

/** `publish` — sign + upload + poll (SPEC §7, Phase B); filled in by the L-E3 publish issue (#17). */
export function buildPublish(io: IO): Command {
  const publish = addGlobalOptions(
    new Command('publish').description('sign (keyless) + upload + poll review status'),
  );
  publish.action(() => notImplemented('publish', publish.opts(), io));
  return publish;
}
