---
'@gridmason/cli': minor
---

Add `gridmason login` / `gridmason whoami` — the keyless OIDC signing identity
(FR-10, SPEC §7/§8, issue #15). `login` establishes the OIDC identity that is the
real trust anchor for signing (registry §2) via the standard Sigstore
`IdentityProvider` surface (`@sigstore/sign`); `whoami` reports the established
issuer + subject. Keyless by default: no long-lived private key — and no token —
is written to disk; the session records only public OIDC claims, and `publish`
re-acquires a short-lived token and mints an ephemeral certificate at signing
time. Shared signing-identity plumbing lands in `src/publish/` (issuer +
`subjectClaims` are projected onto the protocol §4.2 `PublisherSignature` surface
`publish` consumes). Token acquisition supports an explicit token
(`--token` / `GRIDMASON_OIDC_TOKEN`) and the ambient CI context (`--ambient`); the
interactive browser flow is deferred until the registry OIDC issuer allowlist
lands. Bumps `@gridmason/protocol` to `^0.1.0`.
