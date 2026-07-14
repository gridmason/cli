/**
 * `--proxy` mode (SPEC §4, FR-5): forward a widget's SDK calls to a **real
 * running host** so an author can trade fixtures for integration realism — with
 * the capability check **still enforced**. This is the load-bearing rule: a
 * capability the manifest does not declare stays denied *through the proxy*,
 * exactly as it would be denied by the fixture SDK or by a conforming host
 * (`min(user, widget)`, SPEC §5/§6). The dev server never becomes a data backend;
 * it enforces, then forwards allowed calls to the target and relays its answer.
 * The forward envelope itself — path and request/response shape — is pinned by
 * `@gridmason/protocol` (`DEV_PROXY_SDK_PATH` / `DevProxySdkRequest` /
 * `DevProxySdkResponse`), so `dev` and a host meet on one contract, not two.
 *
 * The capability **grammar** has one definition — `@gridmason/protocol` (§3.1) —
 * so this module parses declared capabilities with `parseCapability` and only
 * adds the scope-prefix *grant* rule (an `<api>[:<scope>]` grants a required
 * capability iff the api matches and the declared scope path is a prefix of the
 * required one). That is the same containment the SDK's fixture handle and the
 * picker apply; deriving it from the protocol parser keeps it from drifting.
 */
import {
  type Capability,
  type CapabilityApi,
  DEV_PROXY_SDK_PATH,
  type DevProxySdkRequest,
  formatCapability,
  isDevProxySdkResponse,
  parseCapability,
} from '@gridmason/protocol';
import type { SdkMethod } from '@gridmason/sdk/noop';

/** A capability a gated SDK call requires: an api plus the scope path derived from the call. */
export interface RequiredCapability {
  readonly api: CapabilityApi;
  /** The scope split into a path, e.g. `['recordType', 'customer']` or `['api.acme.com']`. */
  readonly scopePath: readonly string[];
}

/**
 * One SDK call crossing the proxy — the protocol's {@link DevProxySdkRequest}
 * envelope with its `method` narrowed to the SDK's known {@link SdkMethod}
 * vocabulary, which {@link requiredCapability} switches on to derive the gate.
 */
export interface SdkCall extends DevProxySdkRequest {
  readonly method: SdkMethod;
}

/**
 * The capability a gated call requires, or `null` for an **ungated** call
 * (`settings`/`nav`/`telemetry`/`context`/`identity`) that carries no capability.
 * Records/net/events are the gated apis (SPEC §3 rules 1–4); their scope is read
 * off the call's first argument exactly as a host would read it.
 */
export function requiredCapability(call: SdkCall): RequiredCapability | null {
  const first = (call.args[0] ?? {}) as Record<string, unknown>;
  switch (call.method) {
    case 'records.read':
    case 'records.query': {
      const recordType = recordTypeOf(first);
      return recordType === null ? null : { api: 'records.read', scopePath: ['recordType', recordType] };
    }
    case 'records.write': {
      const recordType = recordTypeOf(first);
      return recordType === null ? null : { api: 'records.write', scopePath: ['recordType', recordType] };
    }
    case 'net.fetch': {
      const host = typeof first.host === 'string' ? first.host : null;
      return host === null ? null : { api: 'net', scopePath: [host] };
    }
    case 'events.emit':
    case 'events.on': {
      const ns = typeof first.ns === 'string' ? first.ns : null;
      return ns === null ? null : { api: 'events', scopePath: [ns] };
    }
    default:
      return null;
  }
}

/** The `recordType` of a `records.*` call's first argument (`RecordRef` or `QuerySpec`). */
function recordTypeOf(first: Record<string, unknown>): string | null {
  return typeof first.recordType === 'string' ? first.recordType : null;
}

/**
 * The specific declared capability that grants `required`, or `null` when none
 * does — a declared capability grants when it has the same api and a scope path
 * that is a **prefix** of the required one (unscoped grants all; `records.read:recordType`
 * grants every type; `records.read:recordType:customer` grants only `customer`).
 * The first match wins; callers use it both to gate a call and to attribute a
 * granted call back to the declaration that allowed it (the SDK inspector, cli §4).
 */
export function grantingCapability(
  declared: readonly Capability[],
  required: RequiredCapability,
): Capability | null {
  for (const cap of declared) {
    const parsed = parseCapability(formatCapability(cap));
    if (parsed.ok && parsed.api === required.api && isPrefix(parsed.scopePath, required.scopePath)) {
      return cap;
    }
  }
  return null;
}

/**
 * Whether the widget's `declared` capabilities grant `required` — i.e. some
 * declared capability {@link grantingCapability | grants} it.
 */
export function isGranted(declared: readonly Capability[], required: RequiredCapability): boolean {
  return grantingCapability(declared, required) !== null;
}

/** Whether `prefix` is a (possibly equal) leading slice of `path`. */
function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((seg, i) => seg === path[i]);
}

/** How an enforced, proxied SDK call resolved. */
export type ProxyOutcome =
  | { readonly status: 'denied'; readonly capability: Capability }
  | { readonly status: 'forwarded'; readonly value: unknown }
  | { readonly status: 'error'; readonly message: string };

/**
 * Enforce `declared` against `call`, and on a grant forward it to the `--proxy`
 * target. A denied call **never reaches the target** — enforcement is a gate in
 * front of the transport, not a filter after it. Ungated calls (`requiredCapability`
 * → `null`) forward without a check. The target is expected to answer
 * `POST <proxyUrl>${DEV_PROXY_SDK_PATH}` with `{ ok, value }` (see docs/dev-server.md).
 */
export async function enforceAndForward(
  call: SdkCall,
  declared: readonly Capability[],
  proxyUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProxyOutcome> {
  const required = requiredCapability(call);
  if (required !== null && !isGranted(declared, required)) {
    return { status: 'denied', capability: toCapability(required) };
  }
  return forward(call, proxyUrl, fetchImpl);
}

/** POST the call to the target host and relay its answer. */
async function forward(call: SdkCall, proxyUrl: string, fetchImpl: typeof fetch): Promise<ProxyOutcome> {
  const target = new URL(DEV_PROXY_SDK_PATH, ensureTrailingBase(proxyUrl));
  const request: DevProxySdkRequest = { method: call.method, args: call.args };
  let res: Response;
  try {
    res = await fetchImpl(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (err) {
    return { status: 'error', message: `proxy target unreachable: ${(err as Error).message}` };
  }
  if (!res.ok) {
    return { status: 'error', message: `proxy target returned ${res.status}` };
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { status: 'error', message: 'proxy target returned a non-JSON body' };
  }
  if (!isDevProxySdkResponse(payload)) {
    return { status: 'error', message: 'proxy target returned a malformed response' };
  }
  if (!payload.ok) {
    return { status: 'error', message: payload.error };
  }
  return { status: 'forwarded', value: payload.value };
}

/** The {@link Capability} object form of a required capability, for a denial report. */
export function toCapability(required: RequiredCapability): Capability {
  return required.scopePath.length === 0
    ? { api: required.api }
    : { api: required.api, scope: required.scopePath.join(':') };
}

/** Normalize a proxy base URL so `new URL(path, base)` resolves against its origin. */
function ensureTrailingBase(proxyUrl: string): string {
  // A base without a trailing slash drops its last path segment under URL
  // resolution; the target host is an origin, so normalize to just that.
  const url = new URL(proxyUrl);
  return url.origin;
}
