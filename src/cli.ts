import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import { registerCommands } from './commands/index.js';
import { stdIO, type IO } from './io.js';

// Read the package version at runtime rather than importing package.json, which
// keeps the build a plain `tsc` (no JSON module resolution / copy step). From
// dist/cli.js this resolves to dist/../package.json.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/** Apply a callback to a command and every command in its subtree. */
function eachCommand(cmd: Command, fn: (c: Command) => void): void {
  fn(cmd);
  for (const sub of cmd.commands) {
    eachCommand(sub, fn);
  }
}

/**
 * Build the root program with the full command surface wired to the given sink.
 * Output (help, errors, command notices) is routed through `io` so the whole
 * program is drivable in a unit test with no child process.
 */
export function buildProgram(io: IO = stdIO): Command {
  const program = new Command();
  program
    .name('gridmason')
    .description(
      'The gridmason widget-author devkit: scaffold, develop, lint, and publish widgets to a Gridmason Registry.',
    )
    .version(pkg.version, '-v, --version', 'print the @gridmason/cli version');

  registerCommands(program, io);

  // Route commander's own output (help/errors) through the sink too, on every
  // command in the tree — configuration set via addCommand() is not inherited.
  eachCommand(program, (cmd) =>
    cmd.configureOutput({
      writeOut: (str) => io.out(str),
      writeErr: (str) => io.err(str),
    }),
  );

  // The root intentionally has no default action: with subcommands and no
  // action, commander reports a mistyped command as `unknown command 'x'`
  // (a default action would instead reject it as an excess argument). Bare
  // `gridmason` is handled in run() below.
  return program;
}

/**
 * Parse and dispatch a raw argument vector (already stripped of node + script,
 * i.e. `process.argv.slice(2)`), returning the process exit code. Never calls
 * `process.exit` — commander is put in exit-override mode so help/version/parse
 * failures surface as a return value the caller (or a test) owns.
 */
export async function run(argv: string[], io: IO = stdIO): Promise<number> {
  const program = buildProgram(io);
  eachCommand(program, (cmd) => cmd.exitOverride());

  // Bare `gridmason` prints help to stdout and succeeds (rather than commander's
  // default of help-to-stderr with a non-zero code).
  if (argv.length === 0) {
    io.out(program.helpInformation());
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and --version throw with exitCode 0; parse errors carry their own.
      return err.exitCode;
    }
    throw err;
  }
}
