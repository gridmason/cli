/**
 * `gridmason login` orchestration (SPEC §7): establish the OIDC identity used for
 * keyless signing and record it. Reports its own output (human on stderr, JSON on
 * stdout) and returns a process exit code — `0` on success, `1` on an
 * {@link IdentityError}. No key material is written; see `session.ts`.
 */
import type { IO } from '../io.js';
import { IdentityError, resolveIdentity, type ResolveOptions } from './identity.js';
import { toSession, writeSession } from './session.js';

/** Options `runLogin` accepts: the token-acquisition choices plus `--json`. */
export interface LoginOptions extends ResolveOptions {
  json?: boolean | undefined;
}

/** Run `login`: acquire the OIDC identity, persist it, report it. */
export async function runLogin(opts: LoginOptions, io: IO): Promise<number> {
  let identity;
  try {
    identity = await resolveIdentity(opts);
  } catch (err) {
    return reportIdentityError(err, io, opts.json, 'login');
  }

  const session = toSession(identity);
  const file = await writeSession(session);

  if (opts.json) {
    io.out(
      `${JSON.stringify({ command: 'login', status: 'logged-in', issuer: session.issuer, subject: session.subject })}\n`,
    );
  } else {
    io.err(`Logged in as ${session.subject} via ${session.issuer}.\n`);
    io.err(`Keyless: no signing key was written — this identity will vouch for your artifacts (${file}).\n`);
  }
  return 0;
}

/** Report an {@link IdentityError} (JSON on stdout, human on stderr) and return exit code 1; rethrow anything else. */
export function reportIdentityError(err: unknown, io: IO, jsonMode: boolean | undefined, command: string): number {
  if (!(err instanceof IdentityError)) {
    throw err;
  }
  if (jsonMode) {
    io.out(`${JSON.stringify({ command, status: 'error', code: err.code, message: err.message })}\n`);
  } else {
    io.err(`gridmason: ${err.message}\n`);
  }
  return 1;
}
