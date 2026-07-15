/**
 * The registry client for the **registry-aware** lint checks (SPEC §5 checks 3–4,
 * FR-12): the two read-only registry surfaces `gridmason lint --registry` calls to
 * run its capability diff and its server-validated dependency-DAG check.
 *
 * These surfaces are a **cross-repo contract** with `gridmason/registry` (tracked
 * in gridmason/registry#31): the registry did not expose a capability-history or a
 * pre-release DAG-validation endpoint when this landed (its automated-review stage
 * deliberately runs the offline checks only), so the CLI is built against the
 * contract proposed on that issue and exercised here against a fake server. The
 * shapes below are the wire contract; when the registry ships them, this client
 * pins the same paths and bodies.
 *
 * The transport is hardened the same way `src/net.ts` hardens remote trust-doc
 * fetches — the registry URL is attacker-influenceable config: only `http(s)`, no
 * redirects (a URL cannot silently hop origins), and a hard body cap so a hostile
 * or misbehaving endpoint cannot stream unbounded JSON into a CI run.
 */
import type { RawCapability } from './types.js';

/** Hard cap on a registry JSON response (bytes). Capability lists and cycle paths are tiny; this bounds abuse. */
export const MAX_REGISTRY_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The last published version's declared capabilities for a tag — the baseline the
 * capability diff (check 3) compares the working manifest against. `null` from the
 * client means the tag has never been published on the target registry (a first
 * publish: nothing to diff).
 */
export interface PublishedCapabilities {
  /** The registry that served this record, source-qualifying it (registry §9). Advisory; may be absent. */
  readonly registryId?: string;
  /** The tag whose capabilities these are. */
  readonly tag: string;
  /** The published version the capabilities were read from (the latest approved release). */
  readonly version: string;
  /** The declared capabilities of that version, as raw `{ api, scope? }` pairs. */
  readonly capabilities: readonly RawCapability[];
}

/** One `requires` edge submitted for server-side DAG validation (protocol §3.1 `{ tag, range }`). */
export interface RequiresEdge {
  readonly tag: string;
  readonly range?: string;
}

/** The request body for server-side dependency-DAG validation (check 4 with `--registry`). */
export interface DagValidationRequest {
  /** The submitting widget's own tag — the graph node the `requires` edges leave from. */
  readonly tag: string;
  /** The manifest's `requires` edges, merged into the registry's live graph for the acyclicity check. */
  readonly requires: readonly RequiresEdge[];
}

/**
 * The registry's verdict on the submitted graph merged into its live transitive
 * graph. `acyclic: false` with a `cycle` path (`[a, …, a]`, the repeated final node
 * closing the loop — the same shape `findRequiresCycle` returns) fails the check
 * pre-publish; the registry's own publish-time gate is the authority (registry §7).
 */
export interface DagValidationResult {
  /** The registry that validated the graph, source-qualifying the verdict. Advisory; may be absent. */
  readonly registryId?: string;
  /** Whether the submitted graph is acyclic against the registry's live graph. */
  readonly acyclic: boolean;
  /** The detected cycle as a `[a, …, a]` path when `acyclic` is false; `null`/absent when acyclic. */
  readonly cycle?: readonly string[] | null;
}

/**
 * The read-only registry surfaces the registry-aware checks depend on. An
 * interface, not a concrete class, so a check is tested against a fake and the CLI
 * injects the real {@link HttpRegistryClient} — the checks never touch the network
 * themselves (mirroring how the offline checks are pure functions of their input).
 */
export interface RegistryClient {
  /**
   * Fetch the last published version's declared capabilities for `tag`, or `null`
   * when the tag has never been published (a first publish). Throws on a transport
   * or protocol error (an unreachable registry, a malformed response) — the caller
   * turns that into a `warn`, never a false diff.
   */
  publishedCapabilities(tag: string): Promise<PublishedCapabilities | null>;
  /**
   * Submit the working manifest's `requires` graph for validation against the
   * registry's live transitive graph. Throws on a transport or protocol error; the
   * caller turns that into a `warn`, reserving a `fail` for a graph the registry
   * confirms is cyclic.
   */
  validateDependencyGraph(request: DagValidationRequest): Promise<DagValidationResult>;
}

/** Reject anything that is not an `http(s)` URL (before and after the request). */
function assertHttpUrl(url: string, context: 'requested' | 'final'): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid registry URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported ${context} registry URL scheme "${parsed.protocol}" (only http/https)`);
  }
}

/** Join a base registry URL and an API path, preserving any base path segment. */
function endpoint(base: string, apiPath: string): string {
  const withSlash = base.endsWith('/') ? base : `${base}/`;
  return new URL(apiPath.replace(/^\/+/, ''), withSlash).toString();
}

/** One capped, redirect-refusing fetch: returns the status and the (size-bounded) body text. */
async function fetchCapped(url: string, init: RequestInit, maxBytes: number): Promise<{ status: number; text: string }> {
  assertHttpUrl(url, 'requested');
  const response = await fetch(url, { ...init, redirect: 'error' });
  // `redirect: 'error'` means the final URL equals the requested one; re-check defensively.
  if (typeof response.url === 'string' && response.url.length > 0) {
    assertHttpUrl(response.url, 'final');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new Error(`registry response exceeds the ${maxBytes}-byte cap (declared ${length})`);
    }
  }
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`registry response exceeds the ${maxBytes}-byte cap`);
    }
    return { status: response.status, text };
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`registry response exceeds the ${maxBytes}-byte cap`);
    }
    chunks.push(Buffer.from(value));
  }
  return { status: response.status, text: Buffer.concat(chunks).toString('utf8') };
}

/** A plain, non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a JSON body, wrapping a parse failure as a protocol error with the endpoint named. */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`registry ${what} response was not valid JSON`);
  }
}

/** Read a raw `{ api, scope? }[]` out of an untrusted response, dropping malformed entries. */
function readCapabilities(value: unknown): RawCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: RawCapability[] = [];
  for (const entry of value) {
    if (isObject(entry) && typeof entry.api === 'string') {
      out.push(typeof entry.scope === 'string' ? { api: entry.api, scope: entry.scope } : { api: entry.api });
    }
  }
  return out;
}

/**
 * The HTTP {@link RegistryClient} the CLI wires from `--registry <url>`. Talks the
 * cross-repo contract (gridmason/registry#31):
 *
 * - `GET  <registry>/v1/tags/:tag/capabilities` → `200` {@link PublishedCapabilities}
 *   for the latest published version, or `404` when the tag was never published.
 * - `POST <registry>/v1/dependencies/validate` with a {@link DagValidationRequest}
 *   body → `200` {@link DagValidationResult}.
 */
export class HttpRegistryClient implements RegistryClient {
  constructor(private readonly baseUrl: string) {}

  async publishedCapabilities(tag: string): Promise<PublishedCapabilities | null> {
    const url = endpoint(this.baseUrl, `v1/tags/${encodeURIComponent(tag)}/capabilities`);
    const { status, text } = await fetchCapped(url, { headers: { accept: 'application/json' } }, MAX_REGISTRY_RESPONSE_BYTES);
    // A tag with no prior release is the first-publish case — no baseline to diff.
    if (status === 404) {
      return null;
    }
    if (status < 200 || status >= 300) {
      throw new Error(`registry returned HTTP ${status} for the capability history of "${tag}"`);
    }
    const body = parseJson(text, 'capability-history');
    if (!isObject(body)) {
      throw new Error('registry capability-history response was not an object');
    }
    return {
      ...(typeof body.registryId === 'string' ? { registryId: body.registryId } : {}),
      tag: typeof body.tag === 'string' ? body.tag : tag,
      version: typeof body.version === 'string' ? body.version : '(unknown)',
      capabilities: readCapabilities(body.capabilities),
    };
  }

  async validateDependencyGraph(request: DagValidationRequest): Promise<DagValidationResult> {
    const url = endpoint(this.baseUrl, 'v1/dependencies/validate');
    const { status, text } = await fetchCapped(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ tag: request.tag, requires: request.requires }),
      },
      MAX_REGISTRY_RESPONSE_BYTES,
    );
    if (status < 200 || status >= 300) {
      throw new Error(`registry returned HTTP ${status} for dependency-graph validation`);
    }
    const body = parseJson(text, 'dependency-validation');
    if (!isObject(body) || typeof body.acyclic !== 'boolean') {
      throw new Error('registry dependency-validation response was malformed (no boolean `acyclic`)');
    }
    const cycle = Array.isArray(body.cycle) ? body.cycle.filter((node): node is string => typeof node === 'string') : null;
    return {
      ...(typeof body.registryId === 'string' ? { registryId: body.registryId } : {}),
      acyclic: body.acyclic,
      cycle,
    };
  }
}
