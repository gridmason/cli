import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import type { IO } from '../src/io.js';
import {
  IdentityError,
  STAGING_INSTANCE,
  decodeOidcToken,
  resolveIdentity,
  selectProvider,
  toPublisherIdentity,
} from '../src/publish/identity.js';
import { runLogin } from '../src/publish/login.js';
import { configDir, readSession, sessionPath } from '../src/publish/session.js';
import { runWhoami } from '../src/publish/whoami.js';

/** A capturing IO sink, mirroring cli.test.ts. */
function capture(): { io: IO; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: { out: (s) => outChunks.push(s), err: (s) => errChunks.push(s) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

/** Mint a JWT with the given claims. The signature segment is inert — decode reads claims, never verifies. */
function jwt(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg(claims)}.${Buffer.from('signature').toString('base64url')}`;
}

// A token shaped like one Sigstore staging (`oauth2.sigstage.dev`) would mint —
// the affordance that exercises the identity round-trip against the staging
// config without an interactive browser leg.
const STAGING_TOKEN = jwt({
  iss: STAGING_INSTANCE.oidcIssuer,
  email: 'tester@example.com',
  sub: 'CgcyMTQ4NzcyEgZnaXRodWI',
  exp: 1_900_000_000,
});

// Captured before the env is scrubbed for isolation: when a real staging token is
// exported, the env-gated live test below exercises the full round-trip.
const LIVE_TOKEN = process.env.GRIDMASON_OIDC_TOKEN;

let tmp: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'gm-login-'));
  savedEnv = {
    GRIDMASON_CONFIG_DIR: process.env.GRIDMASON_CONFIG_DIR,
    GRIDMASON_OIDC_TOKEN: process.env.GRIDMASON_OIDC_TOKEN,
    ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  process.env.GRIDMASON_CONFIG_DIR = tmp;
  // Deterministic isolation: no ambient token, no CI OIDC context leaking in.
  delete process.env.GRIDMASON_OIDC_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(tmp, { recursive: true, force: true });
});

describe('decodeOidcToken', () => {
  it('reads issuer + email + expiry off a JWT', () => {
    const id = decodeOidcToken(STAGING_TOKEN);
    expect(id.issuer).toBe(STAGING_INSTANCE.oidcIssuer);
    expect(id.subject).toBe('tester@example.com');
    expect(id.subjectClaims).toEqual({ email: 'tester@example.com', sub: 'CgcyMTQ4NzcyEgZnaXRodWI' });
    expect(id.expiresAt).toBe(1_900_000_000);
  });

  it('falls back to `sub` when the issuer asserts no email', () => {
    const id = decodeOidcToken(jwt({ iss: 'https://token.actions.githubusercontent.com', sub: 'repo:acme/w:ref:main' }));
    expect(id.subject).toBe('repo:acme/w:ref:main');
    expect(id.subjectClaims).toEqual({ sub: 'repo:acme/w:ref:main' });
    expect(id.expiresAt).toBeNull();
  });

  it('rejects a token that is not three segments', () => {
    expect(() => decodeOidcToken('not.a')).toThrow(IdentityError);
    try {
      decodeOidcToken('not.a');
    } catch (err) {
      expect((err as IdentityError).code).toBe('invalid-token');
    }
  });

  it('rejects a token with no issuer claim', () => {
    expect(() => decodeOidcToken(jwt({ email: 'x@y.z' }))).toThrow(/`iss`/);
  });

  it('rejects a token with no subject claim', () => {
    expect(() => decodeOidcToken(jwt({ iss: 'https://issuer.example' }))).toThrow(/subject/);
  });
});

describe('selectProvider', () => {
  it('prefers an explicit token', async () => {
    const provider = selectProvider({ token: STAGING_TOKEN });
    expect(await provider.getToken()).toBe(STAGING_TOKEN);
  });

  it('reads GRIDMASON_OIDC_TOKEN from the environment', async () => {
    process.env.GRIDMASON_OIDC_TOKEN = STAGING_TOKEN;
    expect(await selectProvider({}).getToken()).toBe(STAGING_TOKEN);
  });

  it('refuses interactive login when no interactive factory is wired (non-interactive context)', () => {
    try {
      selectProvider({});
      expect.unreachable('selectProvider should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IdentityError);
      expect((err as IdentityError).code).toBe('interactive-unsupported');
    }
  });

  it('uses the interactive browser factory as the last resort when one is supplied', async () => {
    const provider = selectProvider({ interactive: () => ({ getToken: () => Promise.resolve(STAGING_TOKEN) }) });
    expect(await provider.getToken()).toBe(STAGING_TOKEN);
  });

  it('prefers an explicit token over the interactive factory', async () => {
    const provider = selectProvider({
      token: STAGING_TOKEN,
      interactive: () => ({ getToken: () => Promise.reject(new Error('should not be called')) }),
    });
    expect(await provider.getToken()).toBe(STAGING_TOKEN);
  });
});

describe('toPublisherIdentity', () => {
  it('projects onto the protocol §4.2 PublisherSignature fields', () => {
    const id = decodeOidcToken(STAGING_TOKEN);
    const publisher = toPublisherIdentity(id);
    expect(publisher).toEqual({
      issuer: STAGING_INSTANCE.oidcIssuer,
      subjectClaims: { email: 'tester@example.com', sub: 'CgcyMTQ4NzcyEgZnaXRodWI' },
    });
  });
});

describe('login -> whoami round-trip (Sigstore staging config)', () => {
  it('establishes an identity that whoami then reports (issuer + subject)', async () => {
    const login = capture();
    expect(await runLogin({ token: STAGING_TOKEN }, login.io)).toBe(0);
    expect(login.err()).toContain('tester@example.com');

    const whoami = capture();
    expect(await runWhoami({ json: true }, whoami.io)).toBe(0);
    const reported = JSON.parse(whoami.out()) as {
      status: string;
      issuer: string;
      subject: string;
      subjectClaims: Record<string, string>;
    };
    expect(reported.status).toBe('logged-in');
    expect(reported.issuer).toBe(STAGING_INSTANCE.oidcIssuer);
    expect(reported.subject).toBe('tester@example.com');
    expect(reported.subjectClaims).toEqual({ email: 'tester@example.com', sub: 'CgcyMTQ4NzcyEgZnaXRodWI' });
  });

  it('login --json emits a stable logged-in object', async () => {
    const login = capture();
    await runLogin({ token: STAGING_TOKEN, json: true }, login.io);
    const parsed = JSON.parse(login.out()) as { command: string; status: string; issuer: string; subject: string };
    expect(parsed).toEqual({
      command: 'login',
      status: 'logged-in',
      issuer: STAGING_INSTANCE.oidcIssuer,
      subject: 'tester@example.com',
    });
  });
});

describe('no key material is persisted (keyless posture)', () => {
  it('writes only public identity claims — no token, no private key, no cert', async () => {
    await runLogin({ token: STAGING_TOKEN }, capture().io);

    // Every file under the config dir must be free of key material.
    const entries = await readdir(configDir(), { recursive: true });
    let files = 0;
    for (const entry of entries) {
      const full = path.join(configDir(), entry);
      if (!(await stat(full)).isFile()) continue;
      files += 1;
      expect(entry).not.toMatch(/\.(pem|key|p12|pfx)$/i);
      const contents = await readFile(full, 'utf8');
      expect(contents).not.toMatch(/PRIVATE KEY/i);
      expect(contents).not.toMatch(/BEGIN [A-Z ]*CERTIFICATE/);
    }
    expect(files).toBeGreaterThan(0);

    // The session record itself holds only the identity claims — no token/key/cert fields.
    const session = await readSession();
    expect(session).not.toBeNull();
    expect(Object.keys(session!).sort()).toEqual(
      ['establishedAt', 'expiresAt', 'issuer', 'subject', 'subjectClaims'].sort(),
    );
    const asJson = JSON.stringify(session);
    for (const forbidden of ['token', 'privateKey', 'private_key', 'cert', 'key']) {
      expect(asJson.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('whoami with no session', () => {
  it('reports logged-out and exits non-zero (--json)', async () => {
    const cap = capture();
    expect(await runWhoami({ json: true }, cap.io)).toBe(1);
    expect(JSON.parse(cap.out())).toEqual({ command: 'whoami', status: 'logged-out' });
  });

  it('reports a human hint on stderr and exits non-zero', async () => {
    const cap = capture();
    expect(await runWhoami({}, cap.io)).toBe(1);
    expect(cap.err()).toContain('not logged in');
    expect(cap.out()).toBe('');
  });
});

describe('login with no way to get a token', () => {
  it('reports interactive-unsupported and exits non-zero (--json)', async () => {
    const cap = capture();
    expect(await runLogin({ json: true }, cap.io)).toBe(1);
    const parsed = JSON.parse(cap.out()) as { command: string; status: string; code: string };
    expect(parsed.command).toBe('login');
    expect(parsed.status).toBe('error');
    expect(parsed.code).toBe('interactive-unsupported');
  });

  it('reports an actionable hint on stderr', async () => {
    const cap = capture();
    await runLogin({}, cap.io);
    expect(cap.err()).toMatch(/--token|--ambient/);
  });
});

describe('through the real CLI', () => {
  it('routes `login --token ... --json` then `whoami --json`', async () => {
    const login = capture();
    expect(await run(['login', '--token', STAGING_TOKEN, '--json'], login.io)).toBe(0);
    expect((JSON.parse(login.out()) as { command: string }).command).toBe('login');

    const whoami = capture();
    expect(await run(['whoami', '--json'], whoami.io)).toBe(0);
    expect((JSON.parse(whoami.out()) as { subject: string }).subject).toBe('tester@example.com');

    // Sanity: a session file was actually written under the isolated config dir.
    expect(sessionPath().startsWith(tmp)).toBe(true);
  });

  it('surfaces the login failure exit code through run()', async () => {
    const cap = capture();
    expect(await run(['login', '--json'], cap.io)).toBe(1);
  });
});

// Opt-in: only runs when a real OIDC token is exported (e.g. an ambient Sigstore
// staging token in CI). The interactive browser leg and a live Fulcio round-trip
// are verified manually against staging — see docs/login-whoami.md.
describe('live staging identity (opt-in)', () => {
  it.skipIf(!LIVE_TOKEN)('establishes an identity from a real OIDC token', async () => {
    const identity = await resolveIdentity({ token: LIVE_TOKEN });
    expect(identity.issuer).toMatch(/^https:\/\//);
    expect(identity.subject.length).toBeGreaterThan(0);
  });
});
