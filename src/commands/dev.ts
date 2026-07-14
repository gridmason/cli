import { Command } from 'commander';
import type { IO } from '../io.js';
import { notImplemented } from '../notice.js';
import { addGlobalOptions } from './global-options.js';

/** `dev` — the local author loop (SPEC §4); filled in by the L-E1 dev issue (#9). */
export function buildDev(io: IO): Command {
  const dev = addGlobalOptions(
    new Command('dev').description('local dev server; serves the remote for the dashboard `dev` sideload'),
  );
  dev.action(() => notImplemented('dev', dev.opts(), io));
  return dev;
}
