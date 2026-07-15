import { Command } from 'commander';
import type { IO } from '../io.js';
import { ExitCodeError } from '../exit.js';
import { runLogin } from '../publish/login.js';
import { PRODUCTION_INSTANCE, type InteractiveProviderFactory } from '../publish/identity.js';
import { interactiveBrowserProvider } from '../publish/browser-login.js';
import { addGlobalOptions, type GlobalOptions } from './global-options.js';

/** The `login`-specific flags (on top of the global ones). */
interface LoginFlags extends GlobalOptions {
  token?: string;
  ambient?: boolean;
  audience?: string;
  issuer?: string;
  clientId?: string;
}

/** `login` — establish the OIDC identity for keyless signing (SPEC §7, Phase B); L-E3 issues #15, #49. */
export function buildLogin(io: IO): Command {
  const login = addGlobalOptions(
    new Command('login').description('establish the OIDC identity used for keyless signing'),
  )
    .option('--token <jwt>', 'use an explicit OIDC token instead of an ambient/interactive flow')
    .option('--ambient', 'obtain the OIDC token from the ambient CI context (Sigstore keyless in CI)')
    .option('--audience <aud>', 'OIDC audience for the ambient provider', 'sigstore')
    .option('--issuer <url>', 'OIDC issuer for the interactive browser flow', PRODUCTION_INSTANCE.oidcIssuer)
    .option('--client-id <id>', 'OAuth client id for the interactive browser flow', 'sigstore');

  login.action(async () => {
    const opts = login.opts<LoginFlags>();
    // The interactive browser flow needs a real terminal (to open a browser and
    // for the user to complete sign-in). In a non-TTY context (CI, a pipe, tests)
    // we leave it unwired, so `login` falls through to an actionable
    // `interactive-unsupported` rather than launching a browser that can't be used.
    const interactive: InteractiveProviderFactory | undefined = process.stdin.isTTY
      ? () =>
          interactiveBrowserProvider({
            issuer: opts.issuer ?? PRODUCTION_INSTANCE.oidcIssuer,
            clientId: opts.clientId ?? 'sigstore',
            io,
          })
      : undefined;

    const code = await runLogin(
      {
        token: opts.token,
        ambient: opts.ambient,
        audience: opts.audience,
        json: opts.json,
        ...(interactive ? { interactive } : {}),
      },
      io,
    );
    if (code !== 0) {
      throw new ExitCodeError(code);
    }
  });
  return login;
}
