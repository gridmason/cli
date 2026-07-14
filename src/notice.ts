import type { GlobalOptions } from './commands/global-options.js';
import type { IO } from './io.js';

/**
 * The response every command emits until its real behavior lands. The whole
 * command surface (SPEC §2) is registered from day one so `--help` documents the
 * true shape of the tool and CI can wire against stable command names; each
 * command's implementation arrives in a later cli-v0 milestone (SPEC §10).
 *
 * Honors `--json`: machine consumers get a stable `{ command, status, message }`
 * object on stdout; humans get a one-line notice on stderr.
 */
export function notImplemented(command: string, opts: GlobalOptions, io: IO): void {
  const message =
    `\`gridmason ${command}\` is scaffolded but not yet implemented — ` +
    `it lands in a later cli-v0 milestone (see docs/SPEC.md §10).`;

  if (opts.json) {
    io.out(`${JSON.stringify({ command, status: 'not-implemented', message })}\n`);
  } else {
    io.err(`gridmason: ${message}\n`);
  }
}
