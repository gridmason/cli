import type { ReleaseDoc } from '@gridmason/protocol';
import type { SignatureEnvelope, TransparencyLogEntry } from '@gridmason/protocol';

/**
 * The four untrusted, source-delivered inputs to a release verification — the
 * material the artifact URL (or a local verification-input file) carries. These
 * are handed verbatim to `verifyRelease`; they are validated cryptographically
 * there, not here (a malformed release or trust-root flows through and comes back
 * as the library's own stable verdict — `release-malformed`, `trust-root-malformed`
 * — rather than a CLI error). This module only confirms the four fields are
 * present so there is something to verify.
 *
 * `trustRoot` is deliberately `unknown`: it is the untrusted network document
 * `verifyRelease` parses and gates against the operator's pins.
 */
export interface VerificationInput {
  readonly release: ReleaseDoc;
  readonly envelope: SignatureEnvelope;
  readonly trustRoot: unknown;
  readonly logEntry: TransparencyLogEntry;
}

/** The result of resolving an artifact reference: the inputs, or a stable operational failure. */
export type SourceResult =
  | { readonly ok: true; readonly input: VerificationInput }
  | {
      readonly ok: false;
      readonly code: 'artifact-unreadable' | 'artifact-malformed';
      readonly message: string;
    };

/** Injected IO so the resolver is drivable in tests with neither a network nor a filesystem. */
export interface SourceDeps {
  /** Fetch a remote artifact reference (an `http(s)://` URL) as text. */
  fetchText(url: string): Promise<string>;
  /** Read a local verification-input file as text. */
  readFile(path: string): Promise<string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/**
 * Resolve an artifact reference — an `http(s)://` URL (fetched) or a local path to
 * a verification-input JSON file (read) — into the {@link VerificationInput} the
 * online `verify` path hands to `verifyRelease`.
 *
 * The document is expected to carry `{ release, envelope, trustRoot, logEntry }`
 * (the shape a registry serves for an artifact). Only shallow presence is checked
 * here — deep validation is the protocol library's job, so its stable verdicts
 * survive. A transport/IO failure is `artifact-unreadable`; a non-JSON or
 * shape-incomplete document is `artifact-malformed`.
 *
 * Note: this resolves the *online* source only. The offline `.gmb` bundle format
 * (a signed archive with embedded inclusion proofs) is a separate reader, deferred
 * until protocol P-E4 ships the format; it is intentionally not handled here.
 */
export async function resolveVerificationInput(deps: SourceDeps, ref: string): Promise<SourceResult> {
  let text: string;
  try {
    text = isHttpUrl(ref) ? await deps.fetchText(ref) : await deps.readFile(ref);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'artifact-unreadable', message: `could not read artifact ${ref}: ${detail}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, code: 'artifact-malformed', message: `artifact ${ref} is not valid JSON` };
  }
  if (!isObject(raw)) {
    return { ok: false, code: 'artifact-malformed', message: `artifact ${ref} must be a JSON object` };
  }

  const { release, envelope, trustRoot, logEntry } = raw;
  const missing = (['release', 'envelope', 'trustRoot', 'logEntry'] as const).filter(
    (field) => raw[field] === undefined,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'artifact-malformed',
      message: `artifact ${ref} is missing verification fields: ${missing.join(', ')}`,
    };
  }
  if (!isObject(release) || !isObject(envelope) || !isObject(logEntry)) {
    return {
      ok: false,
      code: 'artifact-malformed',
      message: `artifact ${ref}: release, envelope, and logEntry must be objects`,
    };
  }

  return {
    ok: true,
    input: {
      release: release as unknown as ReleaseDoc,
      envelope: envelope as unknown as SignatureEnvelope,
      trustRoot,
      logEntry: logEntry as unknown as TransparencyLogEntry,
    },
  };
}
