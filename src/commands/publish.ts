import { Command } from 'commander';
import type { IO } from '../io.js';
import { ExitCodeError } from '../exit.js';
import { addGlobalOptions, type GlobalOptions } from './global-options.js';
import { runPublish } from '../publish/run.js';
import { assembleArtifact } from '../publish/artifact.js';
import { acquireIdentity, sigstoreInstance } from '../publish/identity.js';
import { ephemeralSigner, sigstoreSigner } from '../publish/signing.js';
import { fetchTransport } from '../publish/transport.js';

interface PublishOptions extends GlobalOptions {
  token?: string;
  ambient?: boolean;
  sigstore?: string;
  signer?: string;
}

/** The keyless signers `publish` can select (`--signer`). */
const SIGNERS = ['sigstore', 'ephemeral'] as const;
type SignerKind = (typeof SIGNERS)[number];

function isSignerKind(value: string): value is SignerKind {
  return (SIGNERS as readonly string[]).includes(value);
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
 * staging CA); `--signer ephemeral` selects an **offline** self-issued keyless
 * signer for the dev / registry-e2e loop (no Sigstore network — see docs/publish.md).
 */
export function buildPublish(io: IO): Command {
  const publish = addGlobalOptions(
    new Command('publish')
      .argument('[path]', 'widget project directory to publish (defaults to the current directory)')
      .option('--token <jwt>', 'OIDC token to sign + authorize with (else GRIDMASON_OIDC_TOKEN, else ambient CI)')
      .option('--ambient', 'force the ambient CI OIDC provider (Sigstore keyless in CI)')
      .option('--sigstore <instance>', 'Sigstore instance for keyless signing: production (default) or staging')
      .option(
        '--signer <kind>',
        'keyless signer: sigstore (default, live Fulcio) or ephemeral (offline dev/e2e; self-issued cert, not a Fulcio identity)',
      )
      .description('sign (keyless) + upload + poll review status'),
  );
  publish.action(async (projectPath: string | undefined, options: PublishOptions) => {
    if (options.signer !== undefined && !isSignerKind(options.signer)) {
      io.err(`gridmason: unknown --signer "${options.signer}" (expected one of: ${SIGNERS.join(', ')})\n`);
      throw new ExitCodeError(1);
    }
    const resolveOpts = {
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.ambient !== undefined ? { ambient: options.ambient } : {}),
    };
    const instance = sigstoreInstance(options.sigstore);
    // `ephemeral` is the offline dev/e2e signer (no Fulcio, self-issued cert); it
    // ignores the identity provider — the OIDC identity still supplies issuer +
    // subject claims mirrored into the envelope. Default stays live Sigstore.
    const makeSigner =
      options.signer === 'ephemeral'
        ? () => ephemeralSigner()
        : (provider: Parameters<typeof sigstoreSigner>[1]) => sigstoreSigner(instance, provider);

    const code = await runPublish(
      {
        assemble: (root) => assembleArtifact(root),
        acquireIdentity: () => acquireIdentity(resolveOpts),
        makeSigner,
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
