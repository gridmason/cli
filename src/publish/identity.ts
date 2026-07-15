/**
 * Shared signing-identity plumbing (SPEC §7, §8): the **OIDC identity** that is
 * the real trust anchor for keyless signing (registry §2). `login` establishes
 * it, `whoami` reports it, and `publish` binds a short-lived Sigstore certificate
 * to it and mirrors its issuer + subject claims into the signature envelope
 * (protocol §4.2).
 *
 * Keyless by default: this module holds **no bespoke crypto** and never
 * materializes a long-lived private key. Token acquisition is delegated to the
 * standard Sigstore `IdentityProvider` surface (`@sigstore/sign`); the ephemeral
 * signing keypair is minted in-memory by `FulcioSigner` at publish time and never
 * touches disk. Here we only *acquire* an OIDC token and read the claims off it —
 * we do not verify its signature (Fulcio does that before it issues the cert, and
 * the verifier re-derives issuer + identity from the certificate, protocol §4.2),
 * so the claims surfaced here are for display and envelope transport only.
 */
import { CIContextProvider, type IdentityProvider } from '@sigstore/sign';
import type { PublisherSignature } from '@gridmason/protocol';

export type { IdentityProvider };

/** The Fulcio OIDC audience Sigstore tokens are minted for. */
export const SIGSTORE_AUDIENCE = 'sigstore';

/** A Sigstore instance: its keyless endpoints + the interactive OIDC issuer. */
export interface SigstoreInstance {
  readonly name: 'production' | 'staging';
  /** OIDC issuer for the (browser) interactive flow. Ambient tokens carry their own `iss`. */
  readonly oidcIssuer: string;
  /** Fulcio CA that mints the short-lived signing certificate (consumed by `publish`). */
  readonly fulcioURL: string;
  /** Rekor transparency log (consumed by `publish`). */
  readonly rekorURL: string;
}

/** The Sigstore public-good instance — the default target. */
export const PRODUCTION_INSTANCE: SigstoreInstance = {
  name: 'production',
  oidcIssuer: 'https://oauth2.sigstore.dev/auth',
  fulcioURL: 'https://fulcio.sigstore.dev',
  rekorURL: 'https://rekor.sigstore.dev',
};

/** The Sigstore staging instance — the target of the acceptance round-trip. */
export const STAGING_INSTANCE: SigstoreInstance = {
  name: 'staging',
  oidcIssuer: 'https://oauth2.sigstage.dev/auth',
  fulcioURL: 'https://fulcio.sigstage.dev',
  rekorURL: 'https://rekor.sigstage.dev',
};

/** Resolve a Sigstore instance by name; defaults to production. */
export function sigstoreInstance(name?: string | undefined): SigstoreInstance {
  return name === 'staging' ? STAGING_INSTANCE : PRODUCTION_INSTANCE;
}

/**
 * An established OIDC identity: the claims read off the OIDC token. This is the
 * whole of what `login` records and `whoami` reports — it carries no key and no
 * token, only the public claims that name *who will vouch* for an artifact.
 */
export interface OidcIdentity {
  /** The `iss` claim — the trust anchor the registry allowlists (registry §2, protocol §4.4). */
  readonly issuer: string;
  /** Human-facing subject: the `email` claim when present, else `sub`. What `whoami` prints. */
  readonly subject: string;
  /** The identity claims the issuer asserted, mirrored into `PublisherSignature.subjectClaims` at publish. */
  readonly subjectClaims: Readonly<Record<string, string>>;
  /** Unix seconds the underlying token expires (`exp`), or null if it carried none. */
  readonly expiresAt: number | null;
}

/** Enumerated identity failures — callers switch on the code, not the message. */
export type IdentityErrorCode =
  /** No OIDC token could be obtained (no ambient context, no `--token`, provider failed). */
  | 'no-token'
  /** The OIDC token is not a well-formed JWT or is missing a required claim. */
  | 'invalid-token'
  /** The interactive browser flow is not wired yet (awaits the registry issuer allowlist, registry §2). */
  | 'interactive-unsupported'
  /** No identity has been established (`whoami` with no prior `login`). */
  | 'not-logged-in';

/** A typed `login`/identity failure; reported as a stable `{ code }` under `--json`. */
export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

/**
 * Read the claims off an OIDC JWT into an {@link OidcIdentity}. This is plain
 * JWT-payload parsing (base64url + JSON) — **not** crypto: the signature is not
 * checked here (see the module note). Throws {@link IdentityError} `invalid-token`
 * on a malformed token or a token missing `iss` / a subject claim.
 */
export function decodeOidcToken(token: string): OidcIdentity {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    throw new IdentityError('invalid-token', 'the OIDC token is not a well-formed JWT (expected three dot-separated segments)');
  }

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new IdentityError('invalid-token', 'the OIDC token payload is not valid base64url-encoded JSON');
  }

  const issuer = typeof claims.iss === 'string' ? claims.iss : undefined;
  if (!issuer) {
    throw new IdentityError('invalid-token', 'the OIDC token has no `iss` (issuer) claim');
  }

  // Sigstore keys identity off `email` when the issuer asserts one, else `sub`.
  const email = typeof claims.email === 'string' ? claims.email : undefined;
  const sub = typeof claims.sub === 'string' ? claims.sub : undefined;
  const subject = email ?? sub;
  if (!subject) {
    throw new IdentityError('invalid-token', 'the OIDC token has neither an `email` nor a `sub` claim to identify the subject');
  }

  const subjectClaims: Record<string, string> = {};
  for (const key of ['email', 'sub'] as const) {
    const value = claims[key];
    if (typeof value === 'string') {
      subjectClaims[key] = value;
    }
  }

  return {
    issuer,
    subject,
    subjectClaims,
    expiresAt: typeof claims.exp === 'number' ? claims.exp : null,
  };
}

/** How `login` should acquire the OIDC token. */
export interface ResolveOptions {
  /** An explicit OIDC token (`--token` / `GRIDMASON_OIDC_TOKEN`); bypasses ambient + interactive. */
  token?: string | undefined;
  /** Force the ambient CI provider (`--ambient`) — Sigstore keyless in CI. */
  ambient?: boolean | undefined;
  /** OIDC audience for the ambient provider (default `sigstore`). */
  audience?: string | undefined;
  /** Test seam: an explicit identity provider, bypassing selection. */
  provider?: IdentityProvider | undefined;
}

/** True when a GitHub Actions OIDC context is present (the ambient case we auto-enable). */
function hasAmbientOidc(): boolean {
  return Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
}

/**
 * Pick the identity provider for a `login`, in priority order: an injected
 * provider (tests) → an explicit token → the ambient CI context. The interactive
 * browser flow is intentionally **not** wired here: which OIDC issuers are
 * trusted is the registry's trust anchor (registry §2) and the browser leg lands
 * with that decision, so until then we fail with an actionable
 * `interactive-unsupported` rather than guess an issuer allowlist.
 */
export function selectProvider(opts: ResolveOptions): IdentityProvider {
  if (opts.provider) {
    return opts.provider;
  }
  const token = opts.token ?? process.env.GRIDMASON_OIDC_TOKEN;
  if (token) {
    return { getToken: () => Promise.resolve(token) };
  }
  if (opts.ambient ?? hasAmbientOidc()) {
    return new CIContextProvider(opts.audience ?? SIGSTORE_AUDIENCE);
  }
  throw new IdentityError(
    'interactive-unsupported',
    'interactive browser login is not wired yet (it lands with the registry OIDC issuer allowlist, registry §2). ' +
      'Establish identity from a CI OIDC context (run in CI, or pass --ambient), or supply a token directly with ' +
      '--token <jwt> or GRIDMASON_OIDC_TOKEN. See docs/login-whoami.md.',
  );
}

/**
 * Establish an OIDC identity: acquire a token via the selected provider and read
 * its claims. Throws {@link IdentityError} (`no-token` / `invalid-token` /
 * `interactive-unsupported`). No token or key is retained.
 */
export async function resolveIdentity(opts: ResolveOptions = {}): Promise<OidcIdentity> {
  const provider = selectProvider(opts);
  let token: string;
  try {
    token = await provider.getToken();
  } catch (err) {
    throw new IdentityError('no-token', `could not obtain an OIDC token: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!token) {
    throw new IdentityError('no-token', 'the identity provider returned an empty OIDC token');
  }
  return decodeOidcToken(token);
}

/**
 * An OIDC identity acquired for `publish`: the **raw token** (the bearer the
 * Publish API requires *and* the OIDC binding the keyless signer's Fulcio cert is
 * issued against), the decoded claims (display + envelope provenance), and the
 * provider it came from (so the signer re-uses the same identity source). Unlike
 * the persisted session (`session.ts`), the token is held only in memory for the
 * duration of one `publish` and never written.
 */
export interface AcquiredIdentity {
  readonly token: string;
  readonly identity: OidcIdentity;
  readonly provider: IdentityProvider;
}

/**
 * Acquire the OIDC token + claims + provider `publish` needs. Same acquisition
 * rules as {@link resolveIdentity} (injected provider → `--token`/env → ambient
 * CI), but it retains the raw token in memory: `publish` presents it as the upload
 * bearer and binds the keyless signature to it. Throws {@link IdentityError} on
 * any acquisition failure.
 */
export async function acquireIdentity(opts: ResolveOptions = {}): Promise<AcquiredIdentity> {
  const provider = selectProvider(opts);
  let token: string;
  try {
    token = await provider.getToken();
  } catch (err) {
    throw new IdentityError('no-token', `could not obtain an OIDC token: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!token) {
    throw new IdentityError('no-token', 'the identity provider returned an empty OIDC token');
  }
  return { token, identity: decodeOidcToken(token), provider };
}

/**
 * Project an established identity onto the `PublisherSignature` fields `publish`
 * records in the signature envelope (protocol §4.2): the `issuer` and the
 * `subjectClaims` the OIDC issuer asserted. These are mirrored into the envelope
 * as convenience transport — the verifier re-derives them from the short-lived
 * certificate and refuses any mismatch — so `publish` binds them to the cert it
 * mints, never trusting them on their own.
 */
export function toPublisherIdentity(identity: OidcIdentity): Pick<PublisherSignature, 'issuer' | 'subjectClaims'> {
  return { issuer: identity.issuer, subjectClaims: identity.subjectClaims };
}
