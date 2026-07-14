/**
 * Thrown by a command action to make `run()` resolve with a specific non-zero
 * exit code *after the action has already reported its own diagnostics*. Commander
 * ignores an action's return value, so a command that fails on its own terms (not
 * a parse error) signals the intended exit code this way — `run()` maps it to a
 * return value rather than letting the raw error reach the binary's catch-all.
 */
export class ExitCodeError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = 'ExitCodeError';
  }
}
