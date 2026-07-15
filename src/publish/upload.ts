/**
 * The registry Publish + review API client (registry docs/api/publish.md,
 * docs/review/*): upload a content-hashed artifact, poll its review state, and
 * route an appeal to a second reviewer. It speaks the documented contract and maps
 * every response into a stable `{ ok }` result — the CLI never throws a raw
 * transport/HTTP error at the user.
 *
 * Wire shapes the CLI depends on:
 *
 * - `POST /v1/artifacts` — upload. Body `{ tag, version, files[], sourceArchive,
 *   envelope }` with a bearer OIDC token; `201` returns the artifact record
 *   (`{ id, state, contentHashes, … }`); errors carry `{ error: { code, message } }`.
 * - `GET /v1/artifacts/:id` — poll the artifact's state and, on a terminal review
 *   decision, its findings. **Forward contract:** M-B1 advances state
 *   synchronously in the upload response and exposes review findings only on the
 *   reviewer-only lane; this publisher-facing status+findings surface is what the
 *   flow needs and what the contract-faithful fake in the tests serves (see the
 *   PR note). The client parses both a `{ results: CheckResult[] }` automated
 *   report and a `{ findings: [{ checkId, detail }] }` human verdict.
 * - `POST /v1/artifacts/:id/appeal` — route a second review (registry §4).
 *
 * The findings a rejection carries reference the **shared `src/checks` check ids**,
 * so `publish` prints them in the same vocabulary local `lint` uses.
 */
import type { Transport } from './transport.js';
import type { ArtifactFile } from './artifact.js';
import type { DsseEnvelope } from './signing.js';

/** Artifact lifecycle states (registry `src/artifact/types.ts`). */
export type ArtifactState = 'submitted' | 'reviewing' | 'approved' | 'rejected' | 'revoked' | 'killed';

/** The Publish API's artifact record projection (the fields the CLI reads). */
export interface ArtifactRecord {
  readonly id: string;
  readonly tag: string;
  readonly version: string;
  readonly state: ArtifactState;
  readonly registryId?: string;
  readonly contentHashes?: Readonly<Record<string, string>>;
  readonly createdAt?: string;
}

/** A single review finding, normalized to the shared check-id vocabulary. */
export interface ReviewFinding {
  /** A `src/checks` check id, or the `manual` sentinel for a hand-made reviewer finding. */
  readonly checkId: string;
  /** Human-readable detail from the reviewer / automated report. */
  readonly detail: string;
  /** The finding's severity when the source carried one (automated `results`). */
  readonly status?: 'pass' | 'warn' | 'fail';
}

/** A polled review status: the artifact state plus any decision findings. */
export interface ReviewStatus {
  readonly record: ArtifactRecord;
  readonly findings: readonly ReviewFinding[];
}

/** A stable registry error: the HTTP status plus the contract `error.code` / message. */
export interface RegistryError {
  readonly httpStatus: number;
  readonly code: string;
  readonly message: string;
}

/** The client's dependencies — just the transport, injected for testing. */
export interface RegistryClientDeps {
  readonly transport: Transport;
}

/** What an upload needs: the target registry, the bearer token, the artifact, and its envelope. */
export interface UploadRequest {
  readonly registry: string;
  readonly token: string;
  readonly tag: string;
  readonly version: string;
  readonly files: readonly ArtifactFile[];
  readonly sourceArchive: Uint8Array;
  readonly envelope: DsseEnvelope;
}

/** A `{ ok }` result carrying either the value or a {@link RegistryError}. */
export type ClientResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RegistryError };

/** Join a registry base URL with an API path, tolerating a trailing slash on the base. */
function apiUrl(registry: string, path: string): string {
  return new URL(path, registry.endsWith('/') ? registry : `${registry}/`).toString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the uniform `{ error: { code, message } }` body, falling back to a synthetic error. */
function toRegistryError(status: number, body: unknown): RegistryError {
  if (isObject(body) && isObject(body.error) && typeof body.error.code === 'string') {
    const message = typeof body.error.message === 'string' ? body.error.message : body.error.code;
    return { httpStatus: status, code: body.error.code, message };
  }
  return { httpStatus: status, code: 'unexpected_response', message: `registry returned HTTP ${status} with no error body` };
}

/** Parse a body into an {@link ArtifactRecord}, or null if it is not a well-formed record. */
function parseRecord(body: unknown): ArtifactRecord | null {
  if (!isObject(body)) return null;
  const { id, tag, version, state } = body;
  if (typeof id !== 'string' || typeof tag !== 'string' || typeof version !== 'string' || typeof state !== 'string') {
    return null;
  }
  return {
    id,
    tag,
    version,
    state: state as ArtifactState,
    ...(typeof body.registryId === 'string' ? { registryId: body.registryId } : {}),
    ...(isObject(body.contentHashes) ? { contentHashes: body.contentHashes as Record<string, string> } : {}),
    ...(typeof body.createdAt === 'string' ? { createdAt: body.createdAt } : {}),
  };
}

/**
 * Normalize a review payload into {@link ReviewFinding}s. Accepts either the
 * automated report's `results` (`CheckResult[]` — `{ id, status, message }`) or a
 * human verdict's `findings` (`[{ checkId, detail }]`); both reference shared
 * check ids. Only non-`pass` automated results are surfaced (a rejection's
 * actionable findings), while every human finding is kept.
 */
function parseFindings(review: unknown): ReviewFinding[] {
  if (!isObject(review)) return [];
  const findings: ReviewFinding[] = [];
  if (Array.isArray(review.findings)) {
    for (const f of review.findings) {
      if (isObject(f) && typeof f.checkId === 'string' && typeof f.detail === 'string') {
        findings.push({ checkId: f.checkId, detail: f.detail });
      }
    }
  }
  if (Array.isArray(review.results)) {
    for (const r of review.results) {
      if (isObject(r) && typeof r.id === 'string' && typeof r.message === 'string') {
        const status = r.status === 'fail' || r.status === 'warn' || r.status === 'pass' ? r.status : undefined;
        if (status === 'pass') continue;
        findings.push({ checkId: r.id, detail: r.message, ...(status ? { status } : {}) });
      }
    }
  }
  return findings;
}

/**
 * Upload the content-hashed artifact to `POST /v1/artifacts`. Each file part
 * carries its exact bytes base64-encoded, tagged with its role; the source
 * archive and the DSSE envelope ride alongside. Returns the submitted/reviewed
 * artifact record, or the registry's stable error.
 */
export async function uploadArtifact(deps: RegistryClientDeps, req: UploadRequest): Promise<ClientResult<ArtifactRecord>> {
  const body = {
    tag: req.tag,
    version: req.version,
    files: req.files.map((f) => ({ path: f.path, role: f.role, bytes: Buffer.from(f.bytes).toString('base64') })),
    sourceArchive: Buffer.from(req.sourceArchive).toString('base64'),
    envelope: req.envelope,
  };
  const res = await deps.transport.request('POST', apiUrl(req.registry, 'v1/artifacts'), { token: req.token, body });
  if (res.status !== 201 && res.status !== 200) {
    return { ok: false, error: toRegistryError(res.status, res.body) };
  }
  const record = parseRecord(res.body);
  if (!record) {
    return { ok: false, error: { httpStatus: res.status, code: 'unexpected_response', message: 'upload succeeded but the artifact record was malformed' } };
  }
  return { ok: true, value: record };
}

/** Poll one artifact's review status via `GET /v1/artifacts/:id`. */
export async function getReviewStatus(
  deps: RegistryClientDeps,
  args: { registry: string; token: string; id: string },
): Promise<ClientResult<ReviewStatus>> {
  const res = await deps.transport.request('GET', apiUrl(args.registry, `v1/artifacts/${encodeURIComponent(args.id)}`), { token: args.token });
  if (res.status !== 200) {
    return { ok: false, error: toRegistryError(res.status, res.body) };
  }
  const record = parseRecord(res.body);
  if (!record) {
    return { ok: false, error: { httpStatus: res.status, code: 'unexpected_response', message: 'status response was malformed' } };
  }
  const review = isObject(res.body) ? res.body.review : undefined;
  return { ok: true, value: { record, findings: parseFindings(review) } };
}

/** Route a second review via `POST /v1/artifacts/:id/appeal` (registry §4). */
export async function appealArtifact(
  deps: RegistryClientDeps,
  args: { registry: string; token: string; id: string },
): Promise<ClientResult<ArtifactRecord>> {
  const res = await deps.transport.request('POST', apiUrl(args.registry, `v1/artifacts/${encodeURIComponent(args.id)}/appeal`), {
    token: args.token,
    body: {},
  });
  if (res.status !== 201 && res.status !== 200) {
    return { ok: false, error: toRegistryError(res.status, res.body) };
  }
  const record = parseRecord(res.body);
  if (!record) {
    return { ok: false, error: { httpStatus: res.status, code: 'unexpected_response', message: 'appeal succeeded but the artifact record was malformed' } };
  }
  return { ok: true, value: record };
}
