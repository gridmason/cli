import { Command } from 'commander';
import type { IO } from '../io.js';
import { notImplemented } from '../notice.js';
import { addGlobalOptions } from './global-options.js';

/** `whoami` — show the OIDC identity that will vouch for an artifact (SPEC §7, Phase B); L-E3 issue (#15). */
export function buildWhoami(io: IO): Command {
  const whoami = addGlobalOptions(
    new Command('whoami').description('show the OIDC identity that will vouch for an artifact'),
  );
  whoami.action(() => notImplemented('whoami', whoami.opts(), io));
  return whoami;
}
