/**
 * The established-identity session `login` persists and `whoami` reads. By the
 * keyless posture (SPEC §1, §8) the session records **only public OIDC claims** —
 * issuer, subject, the asserted claims, and the token's expiry — never a token
 * and never key material. `publish` re-acquires a fresh short-lived token at
 * signing time; nothing long-lived is cached to disk.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { OidcIdentity } from './identity.js';

/**
 * The on-disk session. It is deliberately a strict subset of {@link OidcIdentity}
 * (plus when it was established) so a reader can see there is no token or key
 * field to leak.
 */
export interface Session {
  readonly issuer: string;
  readonly subject: string;
  readonly subjectClaims: Readonly<Record<string, string>>;
  readonly expiresAt: number | null;
  /** Unix milliseconds when `login` established this identity. */
  readonly establishedAt: number;
}

/**
 * The gridmason config directory: `$GRIDMASON_CONFIG_DIR` (test + ops override) →
 * `$XDG_CONFIG_HOME/gridmason` → `~/.config/gridmason`.
 */
export function configDir(): string {
  const override = process.env.GRIDMASON_CONFIG_DIR;
  if (override && override.trim()) {
    return override;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(homedir(), '.config');
  return path.join(base, 'gridmason');
}

/** Absolute path of the session file. */
export function sessionPath(): string {
  return path.join(configDir(), 'session.json');
}

/** Reduce an identity to the persistable session record (drops nothing sensitive — there is nothing sensitive). */
export function toSession(identity: OidcIdentity, now: number = Date.now()): Session {
  return {
    issuer: identity.issuer,
    subject: identity.subject,
    subjectClaims: identity.subjectClaims,
    expiresAt: identity.expiresAt,
    establishedAt: now,
  };
}

/** Persist the session (owner-only perms) and return its path. */
export async function writeSession(session: Session): Promise<string> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const file = sessionPath();
  await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/** Read the current session, or null when none is established. */
export async function readSession(): Promise<Session | null> {
  try {
    return JSON.parse(await readFile(sessionPath(), 'utf8')) as Session;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/** Remove the session (logout). Returns whether a session was present. */
export async function clearSession(): Promise<boolean> {
  try {
    await rm(sessionPath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}
