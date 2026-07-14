# `gridmason login` / `gridmason whoami`

Establish and inspect the **OIDC identity** that vouches for your artifacts (SPEC
§7, FR-10). Gridmason signs **keyless, Sigstore-style**: there is no long-lived
signing key on your machine. `login` establishes the OIDC identity that is the
real trust anchor (registry §2); at `publish` time a short-lived certificate is
bound to that identity and its issuer + subject claims are recorded in the
signature envelope (protocol §4.2). The CLI orchestrates Sigstore — it is **not a
key vault** (SPEC §1, §8).

```bash
gridmason login   [--token <jwt>] [--ambient] [--audience <aud>]
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
| Interactive browser | — | **not wired yet** (see below) |

The token's claims are read to surface *who will vouch* for an artifact. The
signature itself is **not** verified in the CLI — Fulcio verifies the token before
it issues the certificate, and the verifier re-derives issuer + identity from that
certificate (protocol §4.2), so the CLI holds no bespoke crypto.

### Interactive browser login

The interactive (browser) flow is intentionally deferred: which OIDC issuers are
trusted is the **registry's** trust anchor (registry §2), and the browser leg
lands with that issuer-allowlist decision rather than guessing one here. Until
then, `login` fails with an actionable `interactive-unsupported` message pointing
you to `--ambient` (in CI) or `--token`.

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
