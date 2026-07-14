import { Command } from 'commander';
import type { IO } from '../io.js';
import { notImplemented } from '../notice.js';
import { addGlobalOptions } from './global-options.js';

/** `login` — establish the OIDC identity for keyless signing (SPEC §7, Phase B); L-E3 issue (#15). */
export function buildLogin(io: IO): Command {
  const login = addGlobalOptions(
    new Command('login').description('establish the OIDC identity used for keyless signing'),
  );
  login.action(() => notImplemented('login', login.opts(), io));
  return login;
}
