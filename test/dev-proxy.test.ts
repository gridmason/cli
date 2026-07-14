import type { Capability } from '@gridmason/protocol';
import { describe, expect, it, vi } from 'vitest';
import { enforceAndForward, isGranted, requiredCapability, toCapability } from '../src/dev/proxy.js';

describe('requiredCapability', () => {
  it('derives records.read from a read/query recordType', () => {
    expect(requiredCapability({ method: 'records.read', args: [{ recordType: 'customer', id: 'c1' }] })).toEqual({
      api: 'records.read',
      scopePath: ['recordType', 'customer'],
    });
    expect(requiredCapability({ method: 'records.query', args: [{ recordType: 'team' }] })).toEqual({
      api: 'records.read',
      scopePath: ['recordType', 'team'],
    });
  });

  it('derives records.write, net, and events from their calls', () => {
    expect(requiredCapability({ method: 'records.write', args: [{ recordType: 'customer', id: 'c1' }, {}] })).toEqual({
      api: 'records.write',
      scopePath: ['recordType', 'customer'],
    });
    expect(requiredCapability({ method: 'net.fetch', args: [{ host: 'api.acme.com', path: '/v2' }] })).toEqual({
      api: 'net',
      scopePath: ['api.acme.com'],
    });
    expect(requiredCapability({ method: 'events.on', args: [{ ns: 'acme.sales', name: 't' }] })).toEqual({
      api: 'events',
      scopePath: ['acme.sales'],
    });
  });

  it('treats ungated methods (settings/nav/telemetry) as requiring no capability', () => {
    expect(requiredCapability({ method: 'settings.get', args: [] })).toBeNull();
    expect(requiredCapability({ method: 'nav.toast', args: [{ message: 'hi' }] })).toBeNull();
    expect(requiredCapability({ method: 'telemetry.mark', args: ['x', 1] })).toBeNull();
  });
});

describe('isGranted — scope-prefix containment', () => {
  const declared: Capability[] = [
    { api: 'records.read', scope: 'recordType:example' },
    { api: 'net', scope: 'api.acme.com' },
  ];

  it('grants an exactly-matching scope', () => {
    expect(isGranted(declared, { api: 'records.read', scopePath: ['recordType', 'example'] })).toBe(true);
    expect(isGranted(declared, { api: 'net', scopePath: ['api.acme.com'] })).toBe(true);
  });

  it('denies an undeclared type, host, or api', () => {
    expect(isGranted(declared, { api: 'records.read', scopePath: ['recordType', 'secret'] })).toBe(false);
    expect(isGranted(declared, { api: 'net', scopePath: ['evil.example'] })).toBe(false);
    expect(isGranted(declared, { api: 'records.write', scopePath: ['recordType', 'example'] })).toBe(false);
  });

  it('lets an unscoped or shorter-prefix capability grant a narrower required one', () => {
    expect(isGranted([{ api: 'records.read' }], { api: 'records.read', scopePath: ['recordType', 'x'] })).toBe(true);
    expect(
      isGranted([{ api: 'records.read', scope: 'recordType' }], {
        api: 'records.read',
        scopePath: ['recordType', 'x'],
      }),
    ).toBe(true);
  });
});

describe('toCapability', () => {
  it('omits scope for an unscoped capability and joins the path otherwise', () => {
    expect(toCapability({ api: 'records.read', scopePath: [] })).toEqual({ api: 'records.read' });
    expect(toCapability({ api: 'records.read', scopePath: ['recordType', 'x'] })).toEqual({
      api: 'records.read',
      scope: 'recordType:x',
    });
  });
});

describe('enforceAndForward', () => {
  const declared: Capability[] = [{ api: 'records.read', scope: 'recordType:example' }];

  it('denies an undeclared call without ever calling the target', async () => {
    const fetchImpl = vi.fn();
    const outcome = await enforceAndForward(
      { method: 'records.read', args: [{ recordType: 'secret', id: 's1' }] },
      declared,
      'http://host.test',
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ status: 'denied', capability: { api: 'records.read', scope: 'recordType:secret' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards a granted call to the target and relays its value', async () => {
    const fetchImpl = vi.fn(
      async (_target: URL, _init: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: { ref: { recordType: 'example', id: 'e1' }, fields: {} } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const outcome = await enforceAndForward(
      { method: 'records.read', args: [{ recordType: 'example', id: 'e1' }] },
      declared,
      'http://host.test',
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ status: 'forwarded', value: { ref: { recordType: 'example', id: 'e1' }, fields: {} } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [target, init] = fetchImpl.mock.calls[0]!;
    expect(String(target)).toBe('http://host.test/__gridmason_dev__/sdk');
    expect(JSON.parse(init.body as string)).toEqual({
      method: 'records.read',
      args: [{ recordType: 'example', id: 'e1' }],
    });
  });

  it('forwards an ungated call without a capability check', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: null }), { status: 200 }));
    const outcome = await enforceAndForward(
      { method: 'nav.toast', args: [{ message: 'hi' }] },
      [],
      'http://host.test',
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ status: 'forwarded', value: null });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reports an error when the target is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const outcome = await enforceAndForward(
      { method: 'records.read', args: [{ recordType: 'example', id: 'e1' }] },
      declared,
      'http://host.test',
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ status: 'error', message: 'proxy target unreachable: ECONNREFUSED' });
  });
});
