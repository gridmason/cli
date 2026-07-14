/**
 * The write sink every command and the argument parser route output through.
 * Threading an `IO` (rather than calling `console` / `process.stdout` directly)
 * keeps the whole CLI testable: unit tests inject a capturing sink and assert on
 * exactly what each command wrote, with no child process and no global stubbing.
 *
 * Convention: machine-readable data (`--json`) goes to `out` (stdout); human
 * diagnostics and notices go to `err` (stderr), so a `--json` consumer can parse
 * stdout cleanly.
 */
export interface IO {
  out(text: string): void;
  err(text: string): void;
}

/** The default sink, wired to the real process streams. */
export const stdIO: IO = {
  out(text) {
    process.stdout.write(text);
  },
  err(text) {
    process.stderr.write(text);
  },
};
