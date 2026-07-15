import { Command } from 'commander';
import type { IO } from '../io.js';
import { ExitCodeError } from '../exit.js';
import { addGlobalOptions, type GlobalOptions } from './global-options.js';
import { runAppeal } from '../publish/appeal.js';
import { acquireIdentity } from '../publish/identity.js';
import { fetchTransport } from '../publish/transport.js';

interface AppealOptions extends GlobalOptions {
  token?: string;
  ambient?: boolean;
}

/**
 * `appeal <artifact>` — request a second reviewer for a rejected submission
 * (SPEC §7; registry §4). `<artifact>` is the artifact id `publish` printed.
 * Identity is acquired exactly as `login`/`publish` acquire it.
 */
export function buildAppeal(io: IO): Command {
  const appeal = addGlobalOptions(
    new Command('appeal')
      .argument('<artifact>', 'the artifact id to appeal for a second review')
      .option('--token <jwt>', 'OIDC token to authorize with (else GRIDMASON_OIDC_TOKEN, else ambient CI)')
      .option('--ambient', 'force the ambient CI OIDC provider')
      .description('request a second reviewer for a rejected artifact'),
  );
  appeal.action(async (artifact: string, options: AppealOptions) => {
    const resolveOpts = {
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.ambient !== undefined ? { ambient: options.ambient } : {}),
    };
    const code = await runAppeal(
      {
        acquireIdentity: () => acquireIdentity(resolveOpts),
        client: { transport: fetchTransport() },
      },
      {
        artifact,
        ...(options.registry !== undefined ? { registry: options.registry } : {}),
        ...(options.json ? { json: true } : {}),
      },
      io,
    );
    if (code !== 0) {
      throw new ExitCodeError(code);
    }
  });
  return appeal;
}
