import { Command } from 'commander';
import type { IO } from '../io.js';
import { ExitCodeError } from '../exit.js';
import { runWhoami } from '../publish/whoami.js';
import { addGlobalOptions, type GlobalOptions } from './global-options.js';

/** `whoami` — show the OIDC identity that will vouch for an artifact (SPEC §7, Phase B); L-E3 issue (#15). */
export function buildWhoami(io: IO): Command {
  const whoami = addGlobalOptions(
    new Command('whoami').description('show the OIDC identity that will vouch for an artifact'),
  );
  whoami.action(async () => {
    const opts = whoami.opts<GlobalOptions>();
    const code = await runWhoami({ json: opts.json }, io);
    if (code !== 0) {
      throw new ExitCodeError(code);
    }
  });
  return whoami;
}
