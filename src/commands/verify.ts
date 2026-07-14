import { Command } from 'commander';
import type { IO } from '../io.js';
import { notImplemented } from '../notice.js';
import { addGlobalOptions } from './global-options.js';

/** `verify` — local trust check (SPEC §6, Phase B); filled in by the L-E3 verify issue (#16). */
export function buildVerify(io: IO): Command {
  const verify = addGlobalOptions(
    new Command('verify')
      .argument('<artifact>', 'path to a .gmb artifact or a remote artifact URL')
      .description('verify signature chain + content hash + log inclusion (offline-capable)'),
  );
  verify.action(() => notImplemented('verify', verify.opts(), io));
  return verify;
}
