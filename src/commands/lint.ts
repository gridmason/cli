import { Command } from 'commander';
import type { IO } from '../io.js';
import { notImplemented } from '../notice.js';
import { addGlobalOptions } from './global-options.js';

/** `lint` — the local review checks (SPEC §5); filled in by the L-E2 epic (#11-#14). */
export function buildLint(io: IO): Command {
  const lint = addGlobalOptions(
    new Command('lint').description('run the exact automated registry review checks locally'),
  );
  lint.action(() => notImplemented('lint', lint.opts(), io));
  return lint;
}
