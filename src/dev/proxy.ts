/**
 * `--proxy` mode (SPEC §4, FR-5): forward a widget's SDK calls to a **real
 * running host** so an author can trade fixtures for integration realism — with
 * the capability check **still enforced**. This is the load-bearing rule: a
 * capability the manifest does not declare stays denied *through the proxy*,
 * exactly as it would be denied by the fixture SDK or by a conforming host
 * (`min(user, widget)`, SPEC §5/§6). The dev server never becomes a data backend;
 * it enforces, then forwards allowed calls to the target and relays its answer.
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
  formatCapability,
  parseCapability,
} from '@gridmason/protocol';
import type { SdkMethod } from '@gridmason/sdk/noop';

/** The wire path a proxied SDK call is POSTed to on the `--proxy` target host. */
export const PROXY_SDK_PATH = '/__gridmason_dev__/sdk';

/** A capability a gated SDK call requires: an api plus the scope path derived from the call. */
export interface RequiredCapability {
  readonly api: CapabilityApi;
  /** The scope split into a path, e.g. `['recordType', 'customer']` or `['api.acme.com']`. */
  readonly scopePath: readonly string[];
}

/** One SDK call crossing the proxy: the dotted method and the widget's argument list. */
export interface SdkCall {
  readonly method: SdkMethod;
  readonly args: readonly unknown[];
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
 * Whether the widget's `declared` capabilities grant `required` — some declared
 * capability has the same api and a scope path that is a **prefix** of the
 * required one (unscoped grants all; `records.read:recordType` grants every type;
 * `records.read:recordType:customer` grants only `customer`).
 */
export function isGranted(declared: readonly Capability[], required: RequiredCapability): boolean {
  return declared.some((cap) => {
    const parsed = parseCapability(formatCapability(cap));
    return parsed.ok && parsed.api === required.api && isPrefix(parsed.scopePath, required.scopePath);
  });
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
 * `POST <proxyUrl>${PROXY_SDK_PATH}` with `{ ok, value }` (see docs/dev-server.md).
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
  const target = new URL(PROXY_SDK_PATH, ensureTrailingBase(proxyUrl));
  let res: Response;
  try {
    res = await fetchImpl(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: call.method, args: call.args }),
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
  const body = payload as { ok?: unknown; value?: unknown; error?: unknown };
  if (body.ok === false) {
    return { status: 'error', message: typeof body.error === 'string' ? body.error : 'proxy target reported an error' };
  }
  return { status: 'forwarded', value: body.value };
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
