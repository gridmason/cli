/**
 * `gridmason publish` orchestration (SPEC §7, §8; FR-11). One flow, fail-closed at
 * every gate:
 *
 * 1. **Assemble** the immutable, content-hashed artifact from the project dir
 *    (`artifact.ts`).
 * 2. **Lint-gate** it with the shared `src/checks` — the *same code the registry
 *    runs* — and **refuse to upload** if any check fails (a lint failure, a cyclic
 *    `requires`, or an undeclared capability reach): never upload known-bad
 *    (SPEC §8).
 * 3. **Acquire** the OIDC identity (`login`'s token) and **sign keylessly** into a
 *    DSSE envelope (`signing.ts`).
 * 4. **Upload** to the target registry's Publish API and **poll** review status.
 *    On approval the registry countersigns + logs + CDN-publishes; on rejection
 *    the findings are printed **mapped to the shared lint check ids**
 *    (`findings.ts`).
 *
 * Every external effect — filesystem, identity, signing, HTTP, clock — is injected
 * so the whole flow is drivable against a local (or fake) registry in a test; the
 * command (`src/commands/publish.ts`) wires the production dependencies.
 */
import type { IO } from '../io.js';
import { hasFailure, runChecks, type CheckContext, type CheckResult, type SourceFile } from '../checks/index.js';
import { IdentityError, type AcquiredIdentity } from './identity.js';
import { reportIdentityError } from './login.js';
import type { AssembleResult } from './artifact.js';
import type { ArtifactSigner } from './signing.js';
import { getReviewStatus, uploadArtifact, type ArtifactRecord, type ArtifactState, type RegistryClientDeps, type ReviewFinding } from './upload.js';
import { mapFindings } from './findings.js';
import type { IdentityProvider } from '@sigstore/sign';
import path from 'node:path';

/** Extensions the static-analysis checks treat as widget source (mirrors `src/lint`). */
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

/** Review states that are not yet a verdict — `publish` polls while the artifact sits here. */
const PENDING_STATES: ReadonlySet<ArtifactState> = new Set<ArtifactState>(['submitted', 'reviewing']);

/** Default polling cadence for asynchronous human review; tests override it. */
const DEFAULT_POLL = { attempts: 20, intervalMs: 3000 } as const;

/** Everything `runPublish` needs from the outside world — all injected for testing. */
export interface PublishDeps {
  /** Assemble the content-hashed artifact from a project dir (default {@link assembleArtifact}). */
  assemble(root: string): Promise<AssembleResult>;
  /** Acquire the OIDC token + claims + provider (throws {@link IdentityError} on failure). */
  acquireIdentity(): Promise<AcquiredIdentity>;
  /** Build the keyless signer bound to the acquired identity's provider. */
  makeSigner(provider: IdentityProvider): ArtifactSigner;
  /** The registry client transport. */
  client: RegistryClientDeps;
  /** Sleep between review-status polls. */
  sleep(ms: number): Promise<void>;
}

/** The parsed arguments a `publish` invocation supplies. */
export interface PublishArgs {
  /** Project directory to publish (defaults to cwd). */
  path?: string | undefined;
  /** Target registry base URL (`--registry`). Required — there is no baked-in default yet. */
  registry?: string | undefined;
  /** Emit the machine-readable JSON report (`--json`). */
  json?: boolean | undefined;
  /** Base directory `path` resolves against; defaults to the process cwd. (test seam) */
  cwd?: string | undefined;
  /** Polling cadence override (test seam). */
  poll?: { attempts?: number; intervalMs?: number } | undefined;
}

/** The status glyph for a finding (mirrors `src/lint`). */
function glyph(status: CheckResult['status']): string {
  return status === 'pass' ? '✓' : status === 'warn' ? '!' : '✗';
}

/** Build the lint {@link CheckContext} from the assembled artifact — the exact bytes the registry reviews. */
function contextFromArtifact(manifest: unknown, files: readonly { path: string; bytes: Uint8Array }[]): CheckContext {
  const sourceFiles: SourceFile[] = files
    .filter((f) => SOURCE_EXTENSIONS.has(path.extname(f.path)))
    .map((f) => ({ path: f.path, contents: Buffer.from(f.bytes).toString('utf8') }));
  return { manifest, sourceFiles };
}

/** Emit a stable JSON line and return its exit code. */
function emitJson(io: IO, payload: Record<string, unknown>): void {
  io.out(`${JSON.stringify(payload)}\n`);
}

/**
 * Run `gridmason publish`. Returns the process exit code: `0` on a published or
 * accepted-and-under-review artifact, `1` on any refusal (lint gate, identity,
 * upload error, rejection) or malformed input.
 */
export async function runPublish(deps: PublishDeps, args: PublishArgs, io: IO): Promise<number> {
  const json = args.json ?? false;

  const registry = args.registry;
  if (!registry) {
    const message = 'no target registry — pass --registry <url> (there is no default registry yet)';
    if (json) emitJson(io, { command: 'publish', status: 'error', code: 'no-registry', message });
    else io.err(`gridmason: ${message}\n`);
    return 1;
  }

  // 1. Assemble the content-hashed artifact.
  const root = path.resolve(args.cwd ?? process.cwd(), args.path ?? '.');
  const assembled = await deps.assemble(root);
  if (!assembled.ok) {
    if (json) emitJson(io, { command: 'publish', status: 'error', code: assembled.code, message: assembled.message });
    else io.err(`gridmason: ${assembled.message}\n`);
    return 1;
  }
  const artifact = assembled.artifact;

  // 2. Lint-gate — the same checks the registry runs, over the exact artifact
  //    bytes. Fail closed: refuse to upload anything that would not pass.
  const results = runChecks(contextFromArtifact(artifact.manifest, artifact.files));
  if (hasFailure(results)) {
    const failures = results.filter((r) => r.status === 'fail');
    if (json) {
      emitJson(io, { command: 'publish', status: 'refused', reason: 'lint-failed', artifact: artifact.id, results });
    } else {
      io.err(`gridmason: refusing to publish ${artifact.id} — it does not pass local lint (never upload known-bad):\n`);
      for (const r of failures) {
        io.err(`${glyph(r.status)} ${r.id}: ${r.message}\n`);
        if (r.hint !== undefined) io.err(`    ↳ ${r.hint}\n`);
      }
      io.err('Fix these and re-run `gridmason publish`. Run `gridmason lint` to see the full report.\n');
    }
    return 1;
  }

  // 3. Acquire identity + sign keylessly.
  let acquired: AcquiredIdentity;
  try {
    acquired = await deps.acquireIdentity();
  } catch (err) {
    if (err instanceof IdentityError) return reportIdentityError(err, io, json, 'publish');
    throw err;
  }
  const signer = deps.makeSigner(acquired.provider);
  let envelope;
  try {
    envelope = await signer.sign({
      subject: {
        artifact: artifact.id,
        contentHashes: artifact.contentHashes,
        issuer: acquired.identity.issuer,
        subjectClaims: acquired.identity.subjectClaims,
      },
      token: acquired.token,
    });
  } catch (err) {
    const message = `keyless signing failed: ${err instanceof Error ? err.message : String(err)}`;
    if (json) emitJson(io, { command: 'publish', status: 'error', code: 'sign-failed', message });
    else io.err(`gridmason: ${message}\n`);
    return 1;
  }

  // 4. Upload.
  const upload = await uploadArtifact(deps.client, {
    registry,
    token: acquired.token,
    tag: artifact.tag,
    version: artifact.version,
    files: artifact.files,
    sourceArchive: artifact.sourceArchive,
    envelope,
  });
  if (!upload.ok) {
    const { code, message, httpStatus } = upload.error;
    if (json) emitJson(io, { command: 'publish', status: 'error', code, message, httpStatus, artifact: artifact.id });
    else io.err(`gridmason: upload rejected (${code}): ${message}\n`);
    return 1;
  }

  // 5. Poll review status until a verdict (or the poll budget / status surface runs out).
  const { record, findings } = await pollReview(deps, { registry, token: acquired.token, initial: upload.value, poll: args.poll });

  return report(io, json, record, findings);
}

/**
 * Poll the artifact's review status to a verdict. Always fetches once (the upload
 * record may not yet carry findings), then continues while the state is pending,
 * up to the poll budget. If the status surface is unavailable (a registry that
 * only advances state synchronously in the upload response), it falls back to the
 * uploaded record rather than failing — the upload still succeeded.
 */
async function pollReview(
  deps: PublishDeps,
  args: { registry: string; token: string; initial: ArtifactRecord; poll?: { attempts?: number; intervalMs?: number } | undefined },
): Promise<{ record: ArtifactRecord; findings: readonly ReviewFinding[] }> {
  const attempts = args.poll?.attempts ?? DEFAULT_POLL.attempts;
  const intervalMs = args.poll?.intervalMs ?? DEFAULT_POLL.intervalMs;

  let record = args.initial;
  let findings: readonly ReviewFinding[] = [];
  for (let i = 0; i < attempts; i++) {
    const polled = await getReviewStatus(deps.client, { registry: args.registry, token: args.token, id: record.id });
    if (!polled.ok) break; // status surface unavailable — keep the upload record's state
    record = polled.value.record;
    findings = polled.value.findings;
    if (!PENDING_STATES.has(record.state)) break;
    if (i < attempts - 1) await deps.sleep(intervalMs);
  }
  return { record, findings };
}

/** Render the terminal outcome and return the exit code. */
function report(io: IO, json: boolean, record: ArtifactRecord, findings: readonly ReviewFinding[]): number {
  switch (record.state) {
    case 'approved': {
      if (json) emitJson(io, { command: 'publish', status: 'published', artifact: `${record.tag}@${record.version}`, id: record.id, state: record.state });
      else {
        io.err(`Published ${record.tag}@${record.version} — the registry countersigned it and will serve it (id ${record.id}).\n`);
      }
      return 0;
    }
    case 'rejected': {
      const mapped = mapFindings(findings);
      if (json) {
        emitJson(io, { command: 'publish', status: 'rejected', artifact: `${record.tag}@${record.version}`, id: record.id, state: record.state, findings: mapped });
      } else {
        io.err(`Rejected ${record.tag}@${record.version} (id ${record.id}) — review findings:\n`);
        if (mapped.length === 0) {
          io.err('  (the registry reported no findings)\n');
        }
        for (const f of mapped) {
          const tier = f.tier ? ` [${f.tier}]` : '';
          io.err(`✗ ${f.checkId}${tier}: ${f.detail}\n`);
        }
        io.err('These use the same check ids as `gridmason lint` — fix them and re-publish, or `gridmason appeal` for a second review.\n');
      }
      return 1;
    }
    case 'submitted':
    case 'reviewing': {
      if (json) emitJson(io, { command: 'publish', status: 'reviewing', artifact: `${record.tag}@${record.version}`, id: record.id, state: record.state });
      else io.err(`Submitted ${record.tag}@${record.version} (id ${record.id}) — under review. Re-check later or watch the registry.\n`);
      return 0;
    }
    default: {
      // revoked / killed right after publish is unexpected; surface it as a failure.
      const message = `unexpected artifact state "${record.state}" after publish`;
      if (json) emitJson(io, { command: 'publish', status: 'error', code: 'unexpected-state', message, id: record.id, state: record.state });
      else io.err(`gridmason: ${message} (id ${record.id})\n`);
      return 1;
    }
  }
}
