import path from 'node:path';
import { canonicalize, hashBytes, type GmbBundle, type Manifest } from '@gridmason/protocol';
import {
  enforcePackedFiles,
  resolveGmbBundle,
  resolveVerificationInput,
  runVerifyOffline,
  type VerifyOfflineDeps,
} from '../verify/index.js';
import { assembleBundle, type SignedRelease } from './pack.js';

/**
 * `bundle export` (SPEC §2, FR-13) — produce a signed offline `.gmb` from a
 * project plus the signed release chain a prior `publish`/registry issued. The
 * whole command is a repackaging: it reads the manifest and the servable bytes
 * from the project, embeds the signed `{ release, envelope, logEntry, trustRoot }`
 * (sourced through the *same* reader the online `verify` uses — no parallel path),
 * seals the archive, and then runs the freshly-written bundle **back through the
 * offline verify chain** as a self-check before reporting success (SPEC §6, §8).
 *
 * Signing is out of scope by design: the CLI mints no certificates, countersigns
 * nothing, and issues no log-inclusion proof (those come from `login`/`publish` and
 * the registry). The signed chain enters through `--release`; until `publish` (#17)
 * and a registry (#19) land, that document is supplied by hand or fetched from a
 * registry URL. See docs/bundle.md for the end-to-end flow and this gap.
 */

/** Injected IO so the whole export is drivable in a unit test with neither fs nor network. */
export interface BundleExportDeps {
  /** Read a local text file (manifest, a local `--release` document, trust config, the written `.gmb`). */
  readText(file: string): Promise<string>;
  /** Read the exact served bytes of one project file (a released servable). */
  readBytes(file: string): Promise<Uint8Array>;
  /** Fetch a remote `--release` document (an `http(s)://` URL) as text. */
  fetchText(url: string): Promise<string>;
  /** Write the produced `.gmb` document. */
  writeText(file: string, data: string): Promise<void>;
  /** Read an environment variable (the `GRIDMASON_TRUST_CONFIG` fallback for the self-check). */
  env(name: string): string | undefined;
  /** Current time, epoch ms — threaded to the offline verifier (the library holds no clock). */
  now(): number;
}

/** The parsed arguments a `bundle export` invocation supplies. */
export interface BundleExportArgs {
  /** Project directory to bundle (the folder holding `manifest.json`); defaults to the current directory. */
  readonly project: string;
  /** Path or `http(s)://` URL of the signed release document (`{ release, envelope, trustRoot, logEntry }`). */
  readonly release: string;
  /** Output `.gmb` path; defaults to `<artifact>.gmb` in the current directory. */
  readonly output?: string;
  /** `--trust-config <path>` for the full-chain self-check; falls back to `GRIDMASON_TRUST_CONFIG`. */
  readonly trustConfig?: string;
  /** Override the `producedBy` provenance stamp (default: the embedded trust root's registry id). */
  readonly producedBy?: string;
  /** `--json`: emit a machine-readable result on stdout. */
  readonly json?: boolean;
}

/** What {@link runBundleExport} returns: an exit code plus the text for each stream. */
export interface ExportRender {
  /** `0` exported and self-verified · `1` refused (a self-check/integrity verdict) · `2` inputs unusable. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const MANIFEST_FILE = 'manifest.json';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** File-name-safe rendering of an artifact id for the default output name (only path separators are unsafe). */
function defaultOutputName(artifact: string): string {
  return `${artifact.replace(/[/\\]/g, '-')}.gmb`;
}

/** The self-check outcome, discriminated by whether pinned roots were available. */
type SelfCheck =
  | { readonly ok: true; readonly mode: 'full'; readonly detail: 'verified' }
  | { readonly ok: true; readonly mode: 'structural'; readonly detail: 'archive+packed integrity ok (no pinned roots — trust chain not checked)' }
  | { readonly ok: false; readonly mode: 'full' | 'structural'; readonly detail: string };

/**
 * Re-read the written bundle and confirm the layers `export` is responsible for:
 * the archive seal (content hash re-derived over the canonical payload) and the
 * packed bytes (every release-map file present and hashing to its committed value).
 * Runs with **no pins** — it is the always-available gate proving the writer
 * produced a self-consistent artifact, independent of the (registry-supplied)
 * signature material.
 */
async function structuralSelfCheck(readText: (f: string) => Promise<string>, output: string): Promise<SelfCheck> {
  const resolved = await resolveGmbBundle(readText, output);
  if (!resolved.ok) {
    return { ok: false, mode: 'structural', detail: `written bundle is unreadable/malformed (${resolved.code})` };
  }
  const bundle: GmbBundle = resolved.bundle;
  let recomputed;
  try {
    recomputed = await hashBytes(canonicalize(bundle.payload));
  } catch {
    return { ok: false, mode: 'structural', detail: 'written payload could not be canonicalized' };
  }
  if (recomputed !== bundle.contentHash) {
    return { ok: false, mode: 'structural', detail: 'archive content hash does not seal the payload' };
  }
  const releaseMap = new Map(Object.entries(bundle.payload.release.files ?? {}));
  const packed = await enforcePackedFiles(bundle, releaseMap);
  if (!packed.ok) {
    return { ok: false, mode: 'structural', detail: 'a released file is missing or its packed bytes do not match the release hash' };
  }
  return { ok: true, mode: 'structural', detail: 'archive+packed integrity ok (no pinned roots — trust chain not checked)' };
}

/**
 * Run the freshly-written bundle back through the **full** offline chain against
 * the operator's pinned roots — the identical `verify --offline` machinery, reused
 * verbatim. Available only when a trust config is (a green result requires the
 * genuine registry/publish signatures; the pinless {@link structuralSelfCheck} is
 * the pre-publish gate).
 */
async function fullSelfCheck(deps: VerifyOfflineDeps, output: string, trustConfig?: string): Promise<SelfCheck> {
  const render = await runVerifyOffline(deps, {
    ref: output,
    ...(trustConfig !== undefined ? { trustConfig } : {}),
    json: true,
  });
  if (render.exitCode === 0) return { ok: true, mode: 'full', detail: 'verified' };
  const parsed = JSON.parse(render.stdout) as { reason?: string; code?: string; message?: string };
  const detail = parsed.reason ?? parsed.code ?? parsed.message ?? 'refused';
  return { ok: false, mode: 'full', detail: `offline verify refused: ${detail}` };
}

/** Render an export failure (an operational error, exit `2`) in human or `--json` form. */
function renderError(code: string, message: string, args: BundleExportArgs): ExportRender {
  if (args.json) {
    return { exitCode: 2, stdout: `${JSON.stringify({ command: 'bundle export', status: 'error', code, message })}\n`, stderr: '' };
  }
  return { exitCode: 2, stdout: '', stderr: `gridmason: ${message}\n` };
}

/** Render an export refusal (a fail-closed verdict, exit `1`) in human or `--json` form. */
function renderRefused(reason: string, message: string, args: BundleExportArgs): ExportRender {
  if (args.json) {
    return { exitCode: 1, stdout: `${JSON.stringify({ command: 'bundle export', status: 'refused', reason, message })}\n`, stderr: '' };
  }
  return { exitCode: 1, stdout: '', stderr: `gridmason: export refused — ${message}\n` };
}

/**
 * Produce a signed offline `.gmb` and self-verify it. Reads the manifest and the
 * signed release source, packs the released servables, seals the archive, writes
 * it, then self-checks — the full offline chain when pinned roots are available,
 * else the pinless archive+packed integrity gate. Exit `0` only when the bundle is
 * written *and* its self-check passes.
 */
export async function runBundleExport(deps: BundleExportDeps, args: BundleExportArgs): Promise<ExportRender> {
  const root = path.resolve(args.project);

  // 1. Manifest — parseable object declaring a string `entry` (needed to classify
  //    the entry module). Export does not re-lint: it repackages an already
  //    registry-reviewed release, so the fail-closed gate is byte-hash-match +
  //    self-verify, not a second lint pass (see docs/bundle.md).
  let manifest: Manifest;
  try {
    const raw = JSON.parse(await deps.readText(path.join(root, MANIFEST_FILE))) as unknown;
    if (!isObject(raw) || typeof raw.entry !== 'string') {
      return renderRefused('manifest-invalid', `${MANIFEST_FILE} is not a valid manifest (missing string "entry")`, args);
    }
    manifest = raw as unknown as Manifest;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return renderError('manifest-unreadable', `could not read ${MANIFEST_FILE} in ${root}: ${detail}`, args);
  }

  // 2. Signed release chain — sourced through the online `verify` reader (same
  //    document shape a registry serves), local file or `http(s)://` URL.
  const source = await resolveVerificationInput({ fetchText: deps.fetchText, readFile: deps.readText }, args.release);
  if (!source.ok) {
    return renderError(source.code, `could not load the signed release from ${args.release}: ${source.message}`, args);
  }
  const signed: SignedRelease = {
    release: source.input.release,
    envelope: source.input.envelope,
    trustRoot: source.input.trustRoot,
    logEntry: source.input.logEntry,
  };

  // 3. Provenance stamp — the embedded trust root's registry id, else an override, else the tool.
  const trustRoot = signed.trustRoot;
  const registryId = isObject(trustRoot) && typeof trustRoot.registryId === 'string' ? trustRoot.registryId : undefined;
  const producedBy = args.producedBy ?? registryId ?? 'gridmason-cli';

  // 4. Pack + seal.
  const assembled = await assembleBundle({
    manifest,
    signed,
    readBytes: (rel) => deps.readBytes(path.join(root, rel)),
    producedBy,
  });
  if (!assembled.ok) {
    return renderRefused(assembled.code, assembled.message, args);
  }

  // 5. Write.
  const output = args.output ?? defaultOutputName(assembled.bundle.payload.release.artifact);
  try {
    await deps.writeText(output, `${JSON.stringify(assembled.bundle)}\n`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return renderError('write-failed', `could not write bundle to ${output}: ${detail}`, args);
  }

  // 6. Self-check the written artifact through the offline chain (SPEC §8, fail-closed).
  const haveTrust = args.trustConfig !== undefined || deps.env('GRIDMASON_TRUST_CONFIG') !== undefined;
  const check = haveTrust
    ? await fullSelfCheck(
        { readFile: deps.readText, env: deps.env, now: deps.now },
        output,
        args.trustConfig,
      )
    : await structuralSelfCheck(deps.readText, output);

  if (!check.ok) {
    return renderRefused('self-check-failed', `self-check failed — ${check.detail}`, args);
  }

  const artifact = assembled.bundle.payload.release.artifact;
  if (args.json) {
    const json = {
      command: 'bundle export',
      status: 'exported',
      bundle: output,
      artifact,
      producedBy,
      fileCount: assembled.fileCount,
      selfCheck: { mode: check.mode, detail: check.detail },
    };
    return { exitCode: 0, stdout: `${JSON.stringify(json)}\n`, stderr: '' };
  }
  const files = assembled.fileCount === 1 ? '1 file' : `${assembled.fileCount} files`;
  return {
    exitCode: 0,
    stdout: '',
    stderr: `gridmason: exported ${output} — ${artifact}, ${files}; self-check ${check.mode === 'full' ? 'verified offline' : check.detail}\n`,
  };
}
