import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IO } from '../src/io.js';
import {
  interactiveBrowserProvider,
  runBrowserAuthFlow,
  type OpenBrowser,
} from '../src/publish/browser-login.js';
import { IdentityError, decodeOidcToken, selectProvider } from '../src/publish/identity.js';
import { runLogin } from '../src/publish/login.js';
import { readSession } from '../src/publish/session.js';

/** A capturing IO sink. */
function capture(): { io: IO; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: { out: (s) => outChunks.push(s), err: (s) => errChunks.push(s) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

/** Mint a JWT (inert signature — the CLI reads claims, never verifies here). */
function jwt(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg(claims)}.${Buffer.from('sig').toString('base64url')}`;
}

interface FakeIssuer {
  url: string;
  close: () => Promise<void>;
}

/**
 * A minimal fake OIDC issuer: OIDC discovery, an authorization endpoint that
 * records the PKCE challenge + nonce against an issued code and 302-redirects to
 * the loopback `redirect_uri`, and a token endpoint that verifies the PKCE `S256`
 * verifier and mints an id_token. `overrideNonce` lets a test force a mismatched
 * nonce; `subjectClaims` shapes the minted identity.
 */
async function startFakeIssuer(opts: { overrideNonce?: string; advertiseIssuer?: string } = {}): Promise<FakeIssuer> {
  const codes = new Map<string, { challenge: string; nonce: string }>();
  let base = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer: opts.advertiseIssuer ?? base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
        }),
      );
      return;
    }
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      const code = `code-${codes.size + 1}`;
      codes.set(code, { challenge: p.get('code_challenge') ?? '', nonce: p.get('nonce') ?? '' });
      const redirect = new URL(p.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', p.get('state') ?? '');
      res.writeHead(302, { location: redirect.toString() }).end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const record = codes.get(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!record || challenge !== record.challenge) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const idToken = jwt({
          iss: base,
          email: 'author@example.com',
          sub: 'user-1',
          nonce: opts.overrideNonce ?? record.nonce,
          exp: 1_900_000_000,
        });
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ id_token: idToken, access_token: 'a', token_type: 'Bearer' }));
      });
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** An `openBrowser` that follows the flow through the fake issuer's /authorize (exercises PKCE + state + nonce). */
const followFlow: OpenBrowser = async (url) => {
  await fetch(url); // fetch follows the /authorize 302 to the loopback /callback
};

let issuer: FakeIssuer;
let tmp: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  issuer = await startFakeIssuer();
  tmp = await mkdtemp(path.join(tmpdir(), 'gm-browser-'));
  savedEnv = {
    GRIDMASON_CONFIG_DIR: process.env.GRIDMASON_CONFIG_DIR,
    GRIDMASON_OIDC_TOKEN: process.env.GRIDMASON_OIDC_TOKEN,
  };
  process.env.GRIDMASON_CONFIG_DIR = tmp;
  delete process.env.GRIDMASON_OIDC_TOKEN;
});

afterEach(async () => {
  await issuer.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(tmp, { recursive: true, force: true });
});

describe('runBrowserAuthFlow (authorization code + PKCE, loopback redirect)', () => {
  it('completes the flow and returns an id_token for the chosen issuer', async () => {
    const cap = capture();
    const token = await runBrowserAuthFlow({ issuer: issuer.url, openBrowser: followFlow, io: cap.io });
    const identity = decodeOidcToken(token);
    expect(identity.issuer).toBe(issuer.url);
    expect(identity.subject).toBe('author@example.com');
    // The non-secret authorization URL is surfaced; the token never is.
    expect(cap.err()).toContain(`${issuer.url}/authorize`);
    expect(cap.err()).not.toContain(token);
  });

  it('rejects a redirect whose state does not match (CSRF guard)', async () => {
    const badState: OpenBrowser = async (url) => {
      const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', 'x');
      redirect.searchParams.set('state', 'not-the-state');
      await fetch(redirect.toString());
    };
    await expect(runBrowserAuthFlow({ issuer: issuer.url, openBrowser: badState })).rejects.toMatchObject({
      code: 'no-token',
      message: expect.stringContaining('state check'),
    });
  });

  it('rejects when the provider redirects with an error', async () => {
    const providerError: OpenBrowser = async (url) => {
      const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('error_description', 'user refused');
      await fetch(redirect.toString());
    };
    await expect(runBrowserAuthFlow({ issuer: issuer.url, openBrowser: providerError })).rejects.toMatchObject({
      code: 'no-token',
      message: expect.stringContaining('access_denied'),
    });
  });

  it('rejects an id_token whose nonce does not echo the request (replay guard)', async () => {
    const badNonceIssuer = await startFakeIssuer({ overrideNonce: 'a-different-nonce' });
    try {
      await expect(
        runBrowserAuthFlow({ issuer: badNonceIssuer.url, openBrowser: followFlow }),
      ).rejects.toMatchObject({ code: 'invalid-token', message: expect.stringContaining('nonce') });
    } finally {
      await badNonceIssuer.close();
    }
  });

  it('times out with an actionable message when the redirect never arrives', async () => {
    const neverOpens: OpenBrowser = () => {};
    await expect(
      runBrowserAuthFlow({ issuer: issuer.url, openBrowser: neverOpens, timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: 'no-token', message: expect.stringContaining('timed out') });
  });

  it('rejects when discovery advertises a different issuer than requested', async () => {
    const spoofed = await startFakeIssuer({ advertiseIssuer: 'https://evil.example' });
    try {
      await expect(runBrowserAuthFlow({ issuer: spoofed.url, openBrowser: followFlow })).rejects.toMatchObject({
        code: 'no-token',
        message: expect.stringContaining('different issuer'),
      });
    } finally {
      await spoofed.close();
    }
  });

  it('fails with an actionable message when discovery is unreachable', async () => {
    await issuer.close();
    await expect(runBrowserAuthFlow({ issuer: issuer.url, openBrowser: followFlow })).rejects.toBeInstanceOf(IdentityError);
    // Re-open so afterEach's close() is a no-op-safe double close.
    issuer = await startFakeIssuer();
  });
});

describe('interactiveBrowserProvider wired through login', () => {
  it('establishes and persists an identity from the browser flow', async () => {
    const cap = capture();
    const provider = interactiveBrowserProvider({ issuer: issuer.url, openBrowser: followFlow, io: cap.io });
    expect(await runLogin({ provider, json: true }, cap.io)).toBe(0);

    const session = await readSession();
    expect(session?.subject).toBe('author@example.com');
    expect(session?.issuer).toBe(issuer.url);
  });

  it('is selected as the last-resort provider when no token/ambient is available', () => {
    const factory = () => interactiveBrowserProvider({ issuer: issuer.url, openBrowser: followFlow });
    const provider = selectProvider({ interactive: factory });
    expect(typeof provider.getToken).toBe('function');
  });
});
