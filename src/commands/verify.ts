import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import type { IO } from '../io.js';
import { ExitCodeError } from '../exit.js';
import { notImplemented } from '../notice.js';
import { runVerify } from '../verify/index.js';
import { addGlobalOptions, type GlobalOptions } from './global-options.js';

interface VerifyOptions extends GlobalOptions {
  trustConfig?: string;
}

/**
 * `verify` — local trust check (SPEC §6): dual signature + content hash +
 * transparency-log inclusion, entirely delegated to the `@gridmason/protocol`
 * verify library (the CLI holds no bespoke crypto). Given an artifact URL (or a
 * local verification-input file) plus **pinned** trust roots, it prints the
 * library's stable-enum verdict and exits `0` verified · `1` refused · `2` no
 * verdict reached (blind config / unreadable artifact).
 *
 * Trust roots are pinned/config-supplied only — `--trust-config <path>` or
 * `GRIDMASON_TRUST_CONFIG`; verify never trusts a root fetched blind (SPEC §4.4).
 *
 * `--offline` verifies a `.gmb` bundle against pinned roots with embedded
 * inclusion proofs. That path is deferred until protocol P-E4 ships the `.gmb`
 * format; the flag remains registered and reports not-yet-implemented so the
 * command surface is stable.
 */
export function buildVerify(io: IO): Command {
  const verify = addGlobalOptions(
    new Command('verify')
      .argument('<artifact>', 'path to a .gmb artifact or a remote artifact URL')
      .option(
        '--trust-config <path>',
        'JSON file of pinned trust roots (pins + CA/countersign roots + log key); ' +
          'falls back to GRIDMASON_TRUST_CONFIG',
      )
      .description('verify signature chain + content hash + log inclusion (offline-capable)'),
  );
  verify.action(async (artifact: string, options: VerifyOptions) => {
    // The offline `.gmb` reader is deferred to protocol P-E4 (see docstring).
    if (options.offline) {
      notImplemented('verify', options, io);
      return;
    }

    const render = await runVerify(
      {
        fetchText: async (url) => {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }
          return response.text();
        },
        readFile: (path) => readFile(path, 'utf8'),
        env: (name) => process.env[name],
        now: () => Date.now(),
      },
      {
        ref: artifact,
        ...(options.trustConfig !== undefined ? { trustConfig: options.trustConfig } : {}),
        ...(options.json ? { json: true } : {}),
      },
    );

    if (render.stdout) io.out(render.stdout);
    if (render.stderr) io.err(render.stderr);
    if (render.exitCode !== 0) {
      throw new ExitCodeError(render.exitCode);
    }
  });
  return verify;
}
