# `gridmason login` / `gridmason whoami`

Establish and inspect the **OIDC identity** that vouches for your artifacts (SPEC
§7, FR-10). Gridmason signs **keyless, Sigstore-style**: there is no long-lived
signing key on your machine. `login` establishes the OIDC identity that is the
real trust anchor (registry §2); at `publish` time a short-lived certificate is
bound to that identity and its issuer + subject claims are recorded in the
signature envelope (protocol §4.2). The CLI orchestrates Sigstore — it is **not a
key vault** (SPEC §1, §8).

```bash
gridmason login   [--token <jwt>] [--ambient] [--audience <aud>] [--issuer <url>] [--client-id <id>]
gridmason whoami
```

## Keyless by default — what is (and isn't) stored

`login` records **only public OIDC claims** — issuer, subject, the asserted
claims, and the token's expiry — to `session.json` under the gridmason config
directory (`$GRIDMASON_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gridmason`, else
`~/.config/gridmason`), written owner-only (`0600`).

- **No private key** is ever written — signing mints an ephemeral keypair in
  memory at `publish` time and discards it.
- **No token** is cached either: `publish` re-acquires a fresh, short-lived OIDC
  token when it signs. The session is a record of *who you are*, not a credential.

## Establishing an identity

`login` obtains an OIDC token through one of these, in priority order:

| Source | How | When |
|---|---|---|
| Explicit token | `--token <jwt>` or `GRIDMASON_OIDC_TOKEN` | scripted / staging / testing |
| Ambient CI context | `--ambient` (auto-detected on GitHub Actions with `id-token: write`) | keyless signing in CI |
| Interactive browser | (default, in an interactive terminal) | local authors without CI creds (see below) |

The token's claims are read to surface *who will vouch* for an artifact. The
signature itself is **not** verified in the CLI — Fulcio verifies the token before
it issues the certificate, and the verifier re-derives issuer + identity from that
certificate (protocol §4.2), so the CLI holds no bespoke crypto.

### Interactive browser login

In an interactive terminal, running `gridmason login` with no token source opens
your browser to sign in. It is the standard OAuth **native-app** flow — an
authorization code with **PKCE** and a `127.0.0.1` **loopback redirect** (RFC
8252):

1. the CLI starts an ephemeral listener bound to `127.0.0.1` only and opens your
   browser at the issuer's authorization endpoint (the authorization URL is also
   printed, so you can open it manually if the browser does not launch);
2. after you sign in, the issuer redirects back to the loopback listener with an
   authorization code, which the CLI exchanges (with the PKCE verifier) for the
   OIDC identity token;
3. the token's claims are read exactly as for the other sources — **no token or
   key is written to disk.**

Which OIDC **issuer** to trust is a per-registry decision (registry §2): the
issuer whose `iss` you authenticate against becomes the trust anchor the registry
allowlists. `login` defaults to the Sigstore public-good issuer
(`oauth2.sigstore.dev`); override it for a different trust domain (for example the
Sigstore **staging** issuer) with `--issuer`, and the OAuth client id with
`--client-id`:

```bash
# default: Sigstore public-good
gridmason login

# a different trust domain (e.g. Sigstore staging, for manual verification)
gridmason login --issuer https://oauth2.sigstage.dev/auth
```

The registry enforces its own issuer **allowlist** (`OIDC_ISSUER_ALLOWLIST`) when
you register or publish, rejecting a token from an un-allowlisted issuer with
`403 issuer_not_allowed` — so pick an issuer the target registry trusts.

The security properties of the flow are the OAuth native-app norms: PKCE `S256`,
`state` and `nonce` validation, a loopback listener bound to `127.0.0.1` on an
ephemeral port, a short redirect timeout, discovery/token fetches that refuse
redirects, and no token ever logged.

**Non-interactive contexts.** When there is no interactive terminal (CI, a pipe,
a headless host), the browser flow is not attempted; `login` fails with an
actionable `interactive-unsupported` message pointing you to `--ambient` (in CI)
or `--token`. `publish` likewise does not open a browser — supply its identity
with `--ambient` or `--token`.

## `whoami`

Prints the established identity — the exact issuer + subject that will vouch for
your artifacts — or reports `logged-out` and exits non-zero if none is set.

```console
$ gridmason whoami --json
{"command":"whoami","status":"logged-in","issuer":"https://oauth2.sigstage.dev/auth","subject":"you@example.com","subjectClaims":{"email":"you@example.com","sub":"..."},"expiresAt":1900000000}
```

Global flags apply: `--json` emits a machine-readable result (and machine-readable
errors) on stdout; human output goes to stderr.

## Verifying against Sigstore staging

The identity round-trip is exercised against the **staging** configuration
(`oauth2.sigstage.dev` / `fulcio.sigstage.dev`) in the test suite via the token
affordance — a staging-shaped OIDC token drives `login` → `whoami`. A full live
round-trip runs opt-in when a real staging token is exported as
`GRIDMASON_OIDC_TOKEN` (otherwise skipped). The interactive browser leg is
verified manually against staging.
