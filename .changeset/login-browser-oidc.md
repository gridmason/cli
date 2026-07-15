---
'@gridmason/cli': minor
---

Add the interactive browser sign-in leg to `gridmason login` (SPEC §7, FR-10).

In an interactive terminal, `login` with no token source now opens the browser to
sign in via the standard OAuth **native-app** flow — an authorization code with
**PKCE** (`S256`) and a `127.0.0.1` **loopback redirect** (RFC 8252): it starts an
ephemeral loopback listener, opens the issuer's authorization endpoint (and prints
the URL for manual use), receives the code, exchanges it for the OIDC identity
token, and reads its claims — with `state` + `nonce` validation, redirect-refusing
fetches, and **no token or key written to disk**. Pick the trust anchor with
`--issuer` (default: the Sigstore public-good issuer) and the OAuth client with
`--client-id`. Non-interactive contexts (CI, pipes, headless) are unchanged: they
still fail fast with an actionable `interactive-unsupported` message pointing to
`--ambient` or `--token`. See `docs/login-whoami.md`.
