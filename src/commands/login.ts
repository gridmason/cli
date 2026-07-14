import { Command } from 'commander';
import type { IO } from '../io.js';
import { ExitCodeError } from '../exit.js';
import { runLogin } from '../publish/login.js';
import { addGlobalOptions, type GlobalOptions } from './global-options.js';

/** The `login`-specific flags (on top of the global ones). */
interface LoginFlags extends GlobalOptions {
  token?: string;
  ambient?: boolean;
  audience?: string;
}

/** `login` — establish the OIDC identity for keyless signing (SPEC §7, Phase B); L-E3 issue (#15). */
export function buildLogin(io: IO): Command {
  const login = addGlobalOptions(
    new Command('login').description('establish the OIDC identity used for keyless signing'),
  )
    .option('--token <jwt>', 'use an explicit OIDC token instead of an ambient/interactive flow')
    .option('--ambient', 'obtain the OIDC token from the ambient CI context (Sigstore keyless in CI)')
    .option('--audience <aud>', 'OIDC audience for the ambient provider', 'sigstore');

  login.action(async () => {
    const opts = login.opts<LoginFlags>();
    const code = await runLogin(
      { token: opts.token, ambient: opts.ambient, audience: opts.audience, json: opts.json },
      io,
    );
    if (code !== 0) {
      throw new ExitCodeError(code);
    }
  });
  return login;
}
