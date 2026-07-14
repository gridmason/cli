import type { SignatureSubject, VerifyBundleReason } from '@gridmason/protocol';

/**
 * CLI-level failures that stop `verify` *before* the protocol library reaches a
 * verdict — a missing/blind trust configuration, a malformed config file, or an
 * artifact source that could not be fetched/read/shaped. Distinct from a
 * {@link VerifyBundleReason}: those are the library's cryptographic/trust
 * verdicts; these are operational problems that mean no verdict was reached.
 *
 * `no-trust-config` is the SPEC §4.4 / §8 blind-root refusal: the CLI never
 * verifies against a root it was not given out-of-band, so with nothing pinned
 * it refuses to proceed rather than trusting whatever the network served.
 */
export type VerifyErrorCode =
  | 'no-trust-config'
  | 'trust-config-invalid'
  | 'artifact-unreadable'
  | 'artifact-malformed';

/**
 * The outcome of a `verify` run, before rendering. A discriminated union over the
 * three terminal states: a clean pass, a library refusal carrying one stable
 * reason, or a CLI-level operational error. Both the online (`verifyRelease`) and
 * offline (`verifyOfflineBundle`) paths produce this shape, so this type and
 * {@link formatVerdict} are the single seam both render through. The refusal
 * `reason` is typed as {@link VerifyBundleReason}, the superset that adds the two
 * bundle-only archive-integrity classes to the online `VerifyReleaseReason`
 * set — an online refusal is always a member, so both paths type-check.
 */
export type VerifyOutcome =
  | {
      readonly kind: 'verified';
      readonly artifact: string;
      readonly issuer: string;
      readonly subject: SignatureSubject;
      readonly fileCount: number;
    }
  | { readonly kind: 'refused'; readonly reason: VerifyBundleReason }
  | { readonly kind: 'error'; readonly code: VerifyErrorCode; readonly message: string };

/** What {@link formatVerdict} returns: an exit code plus the text for each stream. */
export interface VerdictRender {
  /** `0` verified · `1` a trust/crypto refusal (a verdict was reached) · `2` no verdict reached. */
  readonly exitCode: number;
  /** Machine output for `--json` (stdout), already newline-terminated; empty in human mode. */
  readonly stdout: string;
  /** Human diagnostics (stderr), already newline-terminated; empty in `--json` mode. */
  readonly stderr: string;
}

/**
 * Render a {@link VerifyOutcome} to an exit code and stream text, honoring
 * `--json` (SPEC §6, IO convention: machine data → stdout, human text → stderr).
 *
 * Exit codes are a stable three-way contract for CI: `0` when the artifact
 * verified, `1` when the library reached a refusal verdict (the artifact is
 * present and well-formed but did not pass a trust/crypto check), and `2` when no
 * verdict could be reached (blind trust config, an unreadable artifact, malformed
 * input). A refusal always prints the protocol's stable reason verbatim — never
 * an input-derived identifier (the no-tag-echo rule, SPEC §7).
 */
export function formatVerdict(outcome: VerifyOutcome, opts: { json?: boolean }): VerdictRender {
  switch (outcome.kind) {
    case 'verified': {
      if (opts.json) {
        const json = {
          command: 'verify',
          status: 'verified',
          artifact: outcome.artifact,
          issuer: outcome.issuer,
          subject: outcome.subject,
          fileCount: outcome.fileCount,
        };
        return { exitCode: 0, stdout: `${JSON.stringify(json)}\n`, stderr: '' };
      }
      const files = outcome.fileCount === 1 ? '1 file' : `${outcome.fileCount} files`;
      return {
        exitCode: 0,
        stdout: '',
        stderr: `gridmason: verified ${outcome.artifact} — issuer ${outcome.issuer}, ${files}\n`,
      };
    }
    case 'refused': {
      if (opts.json) {
        const json = { command: 'verify', status: 'refused', reason: outcome.reason };
        return { exitCode: 1, stdout: `${JSON.stringify(json)}\n`, stderr: '' };
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: `gridmason: verification refused — ${outcome.reason}\n`,
      };
    }
    case 'error': {
      if (opts.json) {
        const json = {
          command: 'verify',
          status: 'error',
          code: outcome.code,
          message: outcome.message,
        };
        return { exitCode: 2, stdout: `${JSON.stringify(json)}\n`, stderr: '' };
      }
      return { exitCode: 2, stdout: '', stderr: `gridmason: ${outcome.message}\n` };
    }
  }
}
