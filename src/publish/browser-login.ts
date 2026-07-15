/**
 * The interactive **browser OIDC leg** of `login` (SPEC §7, FR-10): the standard
 * native-app flow — authorization code + PKCE with a localhost loopback redirect
 * (RFC 8252) — for a local author who has neither an ambient CI OIDC context nor
 * an explicit `--token`. It opens the system browser at the issuer's authorization
 * endpoint, receives the authorization code on an ephemeral `127.0.0.1` listener,
 * exchanges it (with the PKCE verifier) for the identity token, and hands that
 * token into the existing identity path (`identity.ts`) — the CLI keeps no bespoke
 * crypto and no long-lived key.
 *
 * Which OIDC issuer to trust is a per-registry decision (registry §2): the caller
 * picks/confirms the issuer (default: the Sigstore public-good instance) and its
 * `iss` becomes the identity's trust anchor. The registry enforces its own issuer
 * allowlist at registration/publish time (`403 issuer_not_allowed`); there is no
 * client-discoverable allowlist to pre-validate against here, so we validate the
 * token's `iss` for self-consistency against the issuer we ran discovery on.
 *
 * Security posture (RFC 8252 / OAuth native-app best practice): PKCE `S256`,
 * `state` + `nonce` validation, the redirect listener bound to `127.0.0.1` only on
 * an ephemeral port, a short timeout, discovery/token fetches that refuse
 * redirects, and **no token is ever logged** (only the non-secret authorization
 * URL is printed so the user can open it manually).
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IO } from '../io.js';
import { IdentityError, type IdentityProvider } from './identity.js';

/** Default OAuth client id for the Sigstore public-good OIDC (Dex) flow. */
export const DEFAULT_OIDC_CLIENT_ID = 'sigstore';
/** OIDC scopes requested for a keyless identity: OpenID + the `email` that names the subject. */
export const DEFAULT_OIDC_SCOPES = 'openid email';
/** How long to wait for the browser to complete the loopback redirect before giving up. */
export const DEFAULT_INTERACTIVE_TIMEOUT_MS = 120_000;

/**
 * Open a URL in the user's browser. Abstracted as a seam so tests drive the
 * redirect against a fake issuer without a real browser, and so a headless caller
 * can substitute its own opener. The default is {@link systemOpenBrowser}.
 */
export type OpenBrowser = (url: string) => void | Promise<void>;

/** Configuration for one interactive browser sign-in. */
export interface InteractiveOptions {
  /** OIDC issuer URL to authenticate against — its `iss` becomes the identity's trust anchor. */
  readonly issuer: string;
  /** OAuth client id (default {@link DEFAULT_OIDC_CLIENT_ID}). */
  readonly clientId?: string | undefined;
  /** Space-delimited OIDC scopes (default {@link DEFAULT_OIDC_SCOPES}). */
  readonly scopes?: string | undefined;
  /** Browser-open hook (default {@link systemOpenBrowser}). */
  readonly openBrowser?: OpenBrowser | undefined;
  /** Sink for the authorization URL + progress notes (human diagnostics, stderr). */
  readonly io?: IO | undefined;
  /** Redirect timeout in ms (default {@link DEFAULT_INTERACTIVE_TIMEOUT_MS}). */
  readonly timeoutMs?: number | undefined;
}

/** The subset of an OIDC provider's discovery document this flow needs. */
interface OidcMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
}

/** Format an unknown thrown value as a message string (never leaks a token — callers pass no tokens here). */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A cryptographically random, URL-safe value for `state` / `nonce` / the PKCE verifier. */
function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Derive the PKCE `S256` challenge from a verifier (RFC 7636). */
function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Read a token's JWT payload claims (base64url + JSON) — not crypto; mirrors `decodeOidcToken`'s parsing. */
function tokenClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) {
    throw new IdentityError('invalid-token', 'the id_token is not a well-formed JWT (expected three dot-separated segments)');
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new IdentityError('invalid-token', 'the id_token payload is not valid base64url-encoded JSON');
  }
}

/**
 * Run OIDC discovery for `issuer` (`<issuer>/.well-known/openid-configuration`),
 * refusing redirects so a misconfigured issuer cannot bounce the request. Returns
 * the endpoints this flow needs.
 */
async function discover(issuer: string): Promise<OidcMetadata> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'error', headers: { accept: 'application/json' } });
  } catch (err) {
    throw new IdentityError('no-token', `OIDC discovery failed for ${issuer}: ${errMessage(err)}`);
  }
  if (!response.ok) {
    throw new IdentityError('no-token', `OIDC discovery for ${issuer} returned HTTP ${response.status} ${response.statusText}`);
  }
  const meta = (await response.json()) as Partial<OidcMetadata>;
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new IdentityError('no-token', `OIDC discovery for ${issuer} is missing an authorization or token endpoint`);
  }
  // OIDC Discovery §4.3: the advertised `issuer` MUST equal the URL discovery ran
  // against. Enforcing it keeps a misbehaving discovery endpoint from silently
  // swapping the trust anchor out from under the issuer the user chose.
  const advertised = meta.issuer ?? issuer;
  if (advertised.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
    throw new IdentityError('no-token', `OIDC discovery for ${issuer} advertised a different issuer (${advertised})`);
  }
  return {
    issuer: advertised,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
  };
}

/** Build the authorization-endpoint URL for the native-app flow (RFC 8252 + PKCE). */
function authorizationUrl(
  endpoint: string,
  params: { clientId: string; redirectUri: string; scopes: string; state: string; nonce: string; challenge: string },
): string {
  const url = new URL(endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scopes);
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Minimal HTML shown in the browser once the redirect lands, so the user knows to return to the terminal. */
function resultPage(ok: boolean, detail?: string): string {
  const title = ok ? 'Signed in' : 'Sign-in failed';
  const body = ok
    ? 'You are signed in to Gridmason. You can close this tab and return to your terminal.'
    : `Gridmason could not complete sign-in${detail ? `: ${detail}` : ''}. Return to your terminal and try again.`;
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p></body>`;
}

/** Bind an HTTP server to an ephemeral `127.0.0.1` port and resolve the assigned port. */
function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/**
 * Wait for the browser to hit the loopback `/callback`, validate `state`, and
 * resolve the authorization code. Any error response, a `state` mismatch, a
 * missing code, a listener error, or the timeout rejects with an actionable
 * {@link IdentityError}.
 */
function awaitAuthorizationCode(server: Server, expectedState: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new IdentityError(
          'no-token',
          `timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser sign-in to complete. ` +
            'Finish signing in in the browser, or use --token / --ambient. See docs/login-whoami.md.',
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    const finish = (err: IdentityError | null, code?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(code as string);
    };

    server.on('error', (err: Error) => finish(new IdentityError('no-token', `the local sign-in listener failed: ${err.message}`)));

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      const params = url.searchParams;
      const oauthError = params.get('error');
      if (oauthError) {
        const description = params.get('error_description');
        res.writeHead(400, { 'content-type': 'text/html' }).end(resultPage(false, description ?? oauthError));
        finish(
          new IdentityError('no-token', `the OIDC provider returned an error: ${oauthError}${description ? ` (${description})` : ''}`),
        );
        return;
      }
      if (params.get('state') !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/html' }).end(resultPage(false, 'state mismatch'));
        finish(
          new IdentityError(
            'no-token',
            'the browser redirect failed its state check (possible CSRF or a stale sign-in). Run `gridmason login` again.',
          ),
        );
        return;
      }
      const code = params.get('code');
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html' }).end(resultPage(false, 'no authorization code'));
        finish(new IdentityError('no-token', 'the browser redirect carried no authorization code.'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(resultPage(true));
      finish(null, code);
    });
  });
}

/**
 * Exchange the authorization code (with the PKCE verifier) for tokens at the
 * token endpoint, refusing redirects. Returns the `id_token`. On failure the error
 * body is truncated into the message; a token response carries no secret we log.
 */
async function exchangeCode(
  tokenEndpoint: string,
  params: { code: string; redirectUri: string; clientId: string; verifier: string },
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.verifier,
  });
  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      redirect: 'error',
    });
  } catch (err) {
    throw new IdentityError('no-token', `OIDC token exchange failed: ${errMessage(err)}`);
  }
  if (!response.ok) {
    let detail = '';
    try {
      detail = ` (${(await response.text()).slice(0, 200)})`;
    } catch {
      // ignore — the status alone is enough to act on
    }
    throw new IdentityError('no-token', `OIDC token exchange returned HTTP ${response.status}${detail}`);
  }
  const json = (await response.json()) as { id_token?: unknown };
  if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
    throw new IdentityError('no-token', 'the OIDC token response carried no id_token');
  }
  return json.id_token;
}

/** Validate the returned id_token is self-consistent: its `iss` matches discovery and it echoes our `nonce`. */
function validateIdToken(idToken: string, expectedIssuer: string, expectedNonce: string): void {
  const claims = tokenClaims(idToken);
  if (claims.iss !== expectedIssuer) {
    throw new IdentityError(
      'invalid-token',
      `the id_token issuer (${String(claims.iss)}) does not match the OIDC issuer discovery ran against (${expectedIssuer})`,
    );
  }
  if (claims.nonce !== expectedNonce) {
    throw new IdentityError('invalid-token', 'the id_token nonce does not match the value sent (possible replay); sign in again');
  }
}

/**
 * Run the interactive browser sign-in end to end and resolve the raw OIDC
 * `id_token`. Throws an {@link IdentityError} on any leg (discovery, browser
 * redirect, code exchange, token validation). The loopback listener is always
 * closed before returning.
 */
export async function runBrowserAuthFlow(opts: InteractiveOptions): Promise<string> {
  const clientId = opts.clientId ?? DEFAULT_OIDC_CLIENT_ID;
  const scopes = opts.scopes ?? DEFAULT_OIDC_SCOPES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INTERACTIVE_TIMEOUT_MS;
  const open = opts.openBrowser ?? systemOpenBrowser;
  const io = opts.io;

  const meta = await discover(opts.issuer);
  const verifier = randomUrlSafe();
  const challenge = pkceChallenge(verifier);
  const state = randomUrlSafe(16);
  const nonce = randomUrlSafe(16);

  const server = createServer();
  const port = await listenLoopback(server);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const codePromise = awaitAuthorizationCode(server, state, timeoutMs);
  // The redirect (and thus a rejection) can arrive while we `await open(...)`,
  // before the `await codePromise` below attaches its handler. This no-op keeps
  // that early rejection from surfacing as an unhandled rejection; the real
  // outcome still flows through `await codePromise`.
  codePromise.catch(() => {});

  const authUrl = authorizationUrl(meta.authorization_endpoint, { clientId, redirectUri, scopes, state, nonce, challenge });
  io?.err(`Opening your browser to sign in via ${opts.issuer} ...\n`);
  io?.err(`If it does not open automatically, visit this URL to continue:\n  ${authUrl}\n`);
  try {
    await open(authUrl);
  } catch (err) {
    io?.err(`(could not launch a browser automatically: ${errMessage(err)} — open the URL above manually)\n`);
  }

  let code: string;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  const idToken = await exchangeCode(meta.token_endpoint, { code, redirectUri, clientId, verifier });
  validateIdToken(idToken, meta.issuer, nonce);
  return idToken;
}

/**
 * An {@link IdentityProvider} whose `getToken` runs {@link runBrowserAuthFlow}.
 * `selectProvider` (via the `login` command) uses this as the last-resort provider
 * when there is no explicit token and no ambient CI context.
 */
export function interactiveBrowserProvider(opts: InteractiveOptions): IdentityProvider {
  return { getToken: () => runBrowserAuthFlow(opts) };
}

/**
 * Open `url` in the platform's default browser (best effort). Detached and
 * unref'd so it never blocks the CLI; a launch failure is non-fatal because the
 * authorization URL is always printed for manual use, and a truly headless
 * environment surfaces as the redirect timeout with an actionable message.
 */
export function systemOpenBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true });
  // Swallow ENOENT / launch errors: the URL was printed, so the user can open it manually.
  child.on('error', () => {});
  child.unref();
}
