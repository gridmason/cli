import { resolveGmbBundle, runVerifyOffline } from '../verify/index.js';
import type { GmbBundle } from '@gridmason/protocol';

/**
 * `bundle inspect` (SPEC §2, FR-13) — read a `.gmb` and print what it carries for
 * auditing: the manifest identity, the packed file inventory (entry / chunks /
 * schemas / docs), the signing identity and countersignature, the embedded
 * transparency-log inclusion proof, the pinned-root the release anchors to, and the
 * **offline verification verdict**.
 *
 * Reuses the reader (`resolveGmbBundle`) and the verdict path (`runVerifyOffline`)
 * from the `verify --offline` machinery verbatim — inspect adds only presentation.
 * Contents print for any readable bundle; the trust verdict is rendered when the
 * operator supplies pinned roots (`--trust-config` / `GRIDMASON_TRUST_CONFIG`) and
 * is otherwise reported as `unverified` (an inspection is not a trust decision).
 */

/** Injected IO so inspect is drivable in a unit test with no filesystem. */
export interface BundleInspectDeps {
  /** Read the `.gmb` and any trust config as text. */
  readText(file: string): Promise<string>;
  /** Read an environment variable (the `GRIDMASON_TRUST_CONFIG` fallback). */
  env(name: string): string | undefined;
  /** Current time, epoch ms — threaded to the offline verifier for the verdict. */
  now(): number;
}

/** The parsed arguments a `bundle inspect` invocation supplies. */
export interface BundleInspectArgs {
  /** Path to the `.gmb` bundle to inspect. */
  readonly ref: string;
  /** `--trust-config <path>` for the verdict; falls back to `GRIDMASON_TRUST_CONFIG`. */
  readonly trustConfig?: string;
  /** `--json`: emit the full machine-readable inspection on stdout. */
  readonly json?: boolean;
}

/** What {@link runBundleInspect} returns: an exit code plus the text for each stream. */
export interface InspectRender {
  /** `0` inspected (verified, or verification not attempted) · `1` verification refused · `2` unreadable/malformed. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The presentational summary distilled from a bundle's payload (all fields best-effort — inspect never asserts validity). */
interface Summary {
  readonly formatVersion: string;
  readonly producedBy: string;
  readonly artifact: string;
  readonly manifest: { tag: string | undefined; kind: string | undefined; name: string | undefined; version: string | undefined };
  readonly files: { entry: string | undefined; chunks: string[]; schemas: string[]; docs: string[]; total: number };
  readonly identity: { issuer: string | undefined; subjectClaims: Record<string, string>; countersigned: boolean };
  readonly inclusionProof: { logId: string | undefined; index: number | undefined; treeSize: number | undefined; integratedTime: number | undefined };
  readonly trustRoot: { registryId: string | undefined; countersignRoots: string[] };
}

/** Distil a readable bundle into its {@link Summary}, guarding every nested read (a `.gmb` is untrusted input). */
function summarize(bundle: GmbBundle): Summary {
  const payload = bundle.payload as unknown as Record<string, unknown>;
  const manifest = isObject(payload.manifest) ? payload.manifest : {};
  const release = isObject(payload.release) ? payload.release : {};
  const envelope = isObject(payload.envelope) ? payload.envelope : {};
  const publisherSig = isObject(envelope.publisherSig) ? envelope.publisherSig : {};
  const logEntry = isObject(payload.logEntry) ? payload.logEntry : {};
  const inclusion = isObject(logEntry.inclusionProof) ? logEntry.inclusionProof : {};
  const trustRoot = isObject(payload.trustRoot) ? payload.trustRoot : {};

  const paths = (section: unknown): string[] =>
    Array.isArray(section) ? section.map((f) => (isObject(f) ? str(f.path) : undefined)).filter((p): p is string => p !== undefined) : [];
  const chunks = paths(payload.chunks);
  const schemas = paths(payload.schemas);
  const docs = paths(payload.docs);
  const entry = isObject(payload.entry) ? str(payload.entry.path) : undefined;

  const claims = isObject(publisherSig.subjectClaims)
    ? Object.fromEntries(Object.entries(publisherSig.subjectClaims).filter(([, v]) => typeof v === 'string') as [string, string][])
    : {};

  return {
    formatVersion: str(bundle.formatVersion) ?? '?',
    producedBy: str(bundle.producedBy) ?? '?',
    artifact: str(release.artifact) ?? '?',
    manifest: { tag: str(manifest.tag), kind: str(manifest.kind), name: str(manifest.name), version: str(manifest.version) },
    files: { entry, chunks, schemas, docs, total: (entry ? 1 : 0) + chunks.length + schemas.length + docs.length },
    identity: { issuer: str(publisherSig.issuer), subjectClaims: claims, countersigned: isObject(envelope.registrySig) },
    inclusionProof: {
      logId: str(logEntry.logId),
      index: typeof logEntry.index === 'number' ? logEntry.index : undefined,
      treeSize: typeof inclusion.treeSize === 'number' ? inclusion.treeSize : undefined,
      integratedTime: typeof logEntry.integratedTime === 'number' ? logEntry.integratedTime : undefined,
    },
    trustRoot: {
      registryId: str(trustRoot.registryId),
      countersignRoots: Array.isArray(trustRoot.countersignRoots)
        ? trustRoot.countersignRoots.filter((r): r is string => typeof r === 'string')
        : [],
    },
  };
}

/** The verdict portion: run the offline chain when pinned roots are available, else report `unverified`. */
async function verdictOf(
  deps: BundleInspectDeps,
  args: BundleInspectArgs,
): Promise<{ status: string; reason?: string; exitCode: number }> {
  const haveTrust = args.trustConfig !== undefined || deps.env('GRIDMASON_TRUST_CONFIG') !== undefined;
  if (!haveTrust) return { status: 'unverified', exitCode: 0 };
  const render = await runVerifyOffline(
    { readFile: deps.readText, env: deps.env, now: deps.now },
    { ref: args.ref, ...(args.trustConfig !== undefined ? { trustConfig: args.trustConfig } : {}), json: true },
  );
  const parsed = JSON.parse(render.stdout) as { status: string; reason?: string };
  return { status: parsed.status, ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}), exitCode: render.exitCode };
}

/** Render the human-readable inspection block. */
function renderHuman(s: Summary, verdict: { status: string; reason?: string }): string {
  const lines: string[] = [];
  lines.push(`gridmason bundle: ${s.artifact}`);
  lines.push(`  format ${s.formatVersion} · produced by ${s.producedBy}`);
  lines.push(`  manifest: ${s.manifest.tag ?? '?'} (${s.manifest.kind ?? '?'}) ${s.manifest.name ?? ''} v${s.manifest.version ?? '?'}`.trimEnd());
  lines.push(`  files (${s.files.total}):`);
  if (s.files.entry) lines.push(`    entry:   ${s.files.entry}`);
  for (const p of s.files.chunks) lines.push(`    chunk:   ${p}`);
  for (const p of s.files.schemas) lines.push(`    schema:  ${p}`);
  for (const p of s.files.docs) lines.push(`    doc:     ${p}`);
  lines.push(`  identity: issuer ${s.identity.issuer ?? '?'}${s.identity.countersigned ? ' · registry-countersigned' : ' · not countersigned'}`);
  const claimKeys = Object.keys(s.identity.subjectClaims);
  if (claimKeys.length > 0) lines.push(`    claims: ${claimKeys.map((k) => `${k}=${s.identity.subjectClaims[k]}`).join(', ')}`);
  lines.push(`  inclusion proof: log ${s.inclusionProof.logId ?? '?'} · index ${s.inclusionProof.index ?? '?'} · treeSize ${s.inclusionProof.treeSize ?? '?'}`);
  lines.push(`  trust root: ${s.trustRoot.registryId ?? '?'} · roots [${s.trustRoot.countersignRoots.join(', ')}]`);
  lines.push(`  verdict: ${verdict.status}${verdict.reason ? ` (${verdict.reason})` : ''}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Read, summarize, and (optionally) verify a `.gmb`. An unreadable or malformed
 * bundle is a hard error (exit `2`) — there is nothing to inspect. Otherwise the
 * contents always print; the exit code follows the verdict (`0` verified or
 * unverified-by-choice, `1` a trust refusal, from the reused offline chain).
 */
export async function runBundleInspect(deps: BundleInspectDeps, args: BundleInspectArgs): Promise<InspectRender> {
  const resolved = await resolveGmbBundle(deps.readText, args.ref);
  if (!resolved.ok) {
    if (args.json) {
      return {
        exitCode: 2,
        stdout: `${JSON.stringify({ command: 'bundle inspect', status: 'error', code: resolved.code, message: resolved.message })}\n`,
        stderr: '',
      };
    }
    return { exitCode: 2, stdout: '', stderr: `gridmason: ${resolved.message}\n` };
  }

  const summary = summarize(resolved.bundle);
  const verdict = await verdictOf(deps, args);

  if (args.json) {
    const json = { command: 'bundle inspect', ...summary, verdict: { status: verdict.status, ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) } };
    return { exitCode: verdict.exitCode, stdout: `${JSON.stringify(json)}\n`, stderr: '' };
  }
  return { exitCode: verdict.exitCode, stdout: renderHuman(summary, verdict), stderr: '' };
}
