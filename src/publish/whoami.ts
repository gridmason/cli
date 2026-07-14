/**
 * `gridmason whoami` orchestration (SPEC §7): report exactly which OIDC identity
 * is currently established and will vouch for an artifact. Reads the session;
 * reports issuer + subject (human on stderr, JSON on stdout). Returns `0` when an
 * identity is established, `1` when none is (`not-logged-in`).
 */
import type { IO } from '../io.js';
import { readSession } from './session.js';

/** Options `runWhoami` accepts. */
export interface WhoamiOptions {
  json?: boolean | undefined;
}

/** Run `whoami`: report the established OIDC identity, or that there is none. */
export async function runWhoami(opts: WhoamiOptions, io: IO): Promise<number> {
  const session = await readSession();

  if (!session) {
    if (opts.json) {
      io.out(`${JSON.stringify({ command: 'whoami', status: 'logged-out' })}\n`);
    } else {
      io.err('gridmason: not logged in — run `gridmason login` to establish an OIDC identity.\n');
    }
    return 1;
  }

  if (opts.json) {
    io.out(
      `${JSON.stringify({
        command: 'whoami',
        status: 'logged-in',
        issuer: session.issuer,
        subject: session.subject,
        subjectClaims: session.subjectClaims,
        expiresAt: session.expiresAt,
      })}\n`,
    );
  } else {
    io.err(`Logged in as ${session.subject}\n`);
    io.err(`  issuer:  ${session.issuer}\n`);
    io.err(`  subject: ${session.subject}\n`);
  }
  return 0;
}
