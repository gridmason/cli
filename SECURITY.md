# Security Policy

`@gridmason/cli` is the **author-and-publish tool** for Gridmason: it scaffolds
widgets, runs the local review checks that gate publication, orchestrates keyless
signing, and verifies release artifacts. It deliberately holds **no bespoke
crypto** — it verifies with the `@gridmason/protocol` library and signs with
standard Sigstore tooling — and, by keyless default, **no long-lived private
key**. Even so, a defect in this tool can matter: a `lint` check that diverges
from the registry's, a `verify` that accepts a tampered artifact, or a `publish`
path that leaks an identity or key would all undermine the platform's core claim
that *"the reviewed hash is the runnable artifact."* We treat reports here
accordingly.

## Reporting a Vulnerability

**Do not open a public issue, discussion, or pull request for a suspected
vulnerability.** Public disclosure before a fix is available puts authors and the
registries they publish to at risk.

Instead, report privately through GitHub's coordinated disclosure workflow:

1. Go to the **[Security Advisories](https://github.com/gridmason/cli/security/advisories/new)**
   page for this repository (Security tab → Report a vulnerability).
2. Provide as much of the following as you can:
   - Affected version(s) or commit(s), and the affected command/path (e.g.
     `verify`, `lint`, `publish`, `src/checks`).
   - A description of the issue and its security impact (e.g. a tampered artifact
     that `verify` accepts, a `lint` bypass that would let a widget pass local
     checks but fail — or worse, pass — registry review, key or token material
     written to disk, or an identity leak in `login`/`publish`).
   - A minimal reproduction — ideally a failing test or a short script against a
     published `0.x` build.
   - Any known workarounds.

If you cannot use GitHub Security Advisories, contact an administrator of the
[`gridmason`](https://github.com/gridmason) GitHub organization directly to
arrange a private channel.

## What to Expect

- **Acknowledgement** within **3 business days** of your report.
- An initial **assessment and severity triage** within **10 business days**.
- Ongoing updates through the advisory thread as we investigate and prepare a fix.
- **Coordinated disclosure**: we will agree on a disclosure timeline with you. Our
  target is a fix and published advisory within **90 days** of triage;
  actively-exploited issues are handled faster. We will credit you in the advisory
  unless you ask us not to.

We do not currently operate a paid bug-bounty program.

## Supported Versions

Gridmason is pre-1.0. Security fixes land on the latest `0.x` line and are
released as a new patch version; there is no long-term support for older `0.x`
releases. Always use the most recent published version.

| Version | Supported |
| ------- | --------- |
| latest `0.x` | :white_check_mark: |
| older `0.x` | :x: |

Once a `1.0` line ships, this table will be updated with a supported-version
window.

## Scope

In scope — anything that lets the CLI accept an artifact it should reject, sign or
publish something it should not, or mishandle credentials:

- `verify` accepting a tampered artifact, a broken signature chain, a failed
  transparency-log inclusion proof, or a revoked/expired trust root — or trusting
  a root fetched blind rather than pinned.
- `lint` / `src/checks` diverging from the registry's automated review such that a
  known-bad widget passes local checks (the shared-checks contract is a security
  boundary).
- `login` / `publish` writing long-lived key material to disk, leaking an OIDC
  identity or token, or signing under an identity the author did not intend.
- `publish` failing open — uploading an artifact that would not pass local `lint`.
- Supply-chain integrity of the package itself (build, publish provenance,
  dependency pinning).

Out of scope:

- Vulnerabilities rooted in `@gridmason/protocol` (the verification library and
  wire formats) — report those to the
  [`protocol`](https://github.com/gridmason/protocol) repository, unless the CLI
  misuses the library.
- Issues requiring a maliciously modified local build of the CLI.
- Reports generated solely by automated scanners without a demonstrated,
  reproducible security impact.

## Disclosure Philosophy

The CLI's trust properties come from **not** reinventing crypto: it delegates
verification to `@gridmason/protocol` and signing to Sigstore, keeps trust roots
pinned, and by default holds no long-lived key. If you have found a way to make
the tool violate those properties — accept a bad artifact, publish a bad one, or
mishandle an identity — we want to hear from you before anyone else does.
