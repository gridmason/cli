import type { Command } from 'commander';

/**
 * The global flags from SPEC §2, attached to every leaf command so they can be
 * given after the command name (`gridmason lint --registry <url> --json`), which
 * is how the spec's examples spell them. A command reads its own resolved values
 * with `cmd.opts()`.
 */
export interface GlobalOptions {
  /** Target registry; defaults to config, then the flagship registry. */
  registry?: string;
  /** Emit machine-readable JSON for CI consumption. */
  json?: boolean;
  /** Run without network (verify/bundle against pinned roots). */
  offline?: boolean;
}

/** Register the three global flags on a leaf command and return it. */
export function addGlobalOptions(cmd: Command): Command {
  return cmd
    .option('--registry <url>', 'target registry (defaults to config, then the flagship registry)')
    .option('--json', 'emit machine-readable JSON for CI consumption')
    .option('--offline', 'run without network (verify/bundle against pinned roots)');
}
