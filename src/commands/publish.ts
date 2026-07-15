import { Command } from 'commander';
import type { IO } from '../io.js';
import { ExitCodeError } from '../exit.js';
import { addGlobalOptions, type GlobalOptions } from './global-options.js';
import { runPublish } from '../publish/run.js';
import { assembleArtifact } from '../publish/artifact.js';
import { acquireIdentity, sigstoreInstance } from '../publish/identity.js';
import { sigstoreSigner } from '../publish/signing.js';
import { fetchTransport } from '../publish/transport.js';

interface PublishOptions extends GlobalOptions {
  token?: string;
  ambient?: boolean;
  sigstore?: string;
}

/**
 * `publish` — lint-gate + keyless sign + upload + poll (SPEC §7, §8; FR-11). Runs
 * the shared `src/checks` locally first and **refuses to upload** anything that
 * would fail (never upload known-bad), then binds a keyless Sigstore signature to
 * the `login` OIDC identity, uploads the content-hashed artifact to the target
 * registry's Publish API, and polls review status — printing a rejection's
 * findings in the same check-id vocabulary as `gridmason lint`.
 *
 * Identity is acquired exactly as `login` acquires it (`--token` / env / ambient
 * CI, or the interactive browser sign-in flow in a terminal). The keyless signer
 * is the Sigstore public-good instance by default (`--sigstore staging` for the
 * staging CA).
 */
export function buildPublish(io: IO): Command {
  const publish = addGlobalOptions(
    new Command('publish')
      .argument('[path]', 'widget project directory to publish (defaults to the current directory)')
      .option('--token <jwt>', 'OIDC token to sign + authorize with (else GRIDMASON_OIDC_TOKEN, else ambient CI)')
      .option('--ambient', 'force the ambient CI OIDC provider (Sigstore keyless in CI)')
      .option('--sigstore <instance>', 'Sigstore instance for keyless signing: production (default) or staging')
      .description('sign (keyless) + upload + poll review status'),
  );
  publish.action(async (projectPath: string | undefined, options: PublishOptions) => {
    const resolveOpts = {
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.ambient !== undefined ? { ambient: options.ambient } : {}),
    };
    const instance = sigstoreInstance(options.sigstore);

    const code = await runPublish(
      {
        assemble: (root) => assembleArtifact(root),
        acquireIdentity: () => acquireIdentity(resolveOpts),
        makeSigner: (provider) => sigstoreSigner(instance, provider),
        client: { transport: fetchTransport() },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      {
        ...(projectPath !== undefined ? { path: projectPath } : {}),
        ...(options.registry !== undefined ? { registry: options.registry } : {}),
        ...(options.json ? { json: true } : {}),
      },
      io,
    );
    if (code !== 0) {
      throw new ExitCodeError(code);
    }
  });
  return publish;
}
