/**
 * Registry-aware check tests (SPEC §5 checks 3–4, FR-12) — the capability diff and
 * the server-validated dependency-DAG check, driven against a **fake**
 * {@link RegistryClient}. These cover the check logic in isolation (the diff maths,
 * the cycle mapping, the defer/warn/fail decisions); the HTTP client and the full
 * `lint --registry` path are exercised against a real fake server in
 * `lint-registry.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  capabilityDiffCheck,
  registryChecks,
  runRegistryChecks,
  serverDagCheck,
  tierForCheckId,
  TIER_BY_GROUP,
  type DagValidationRequest,
  type DagValidationResult,
  type PublishedCapabilities,
  type RegistryCheckContext,
  type RegistryClient,
} from '../src/checks/index.js';

/** A fake registry client whose responses (or thrown errors) each case sets. */
function fakeClient(overrides: Partial<{
  capabilities: PublishedCapabilities | null | (() => never);
  dag: DagValidationResult | (() => never);
}> = {}): RegistryClient {
  return {
    async publishedCapabilities(): Promise<PublishedCapabilities | null> {
      const value = overrides.capabilities;
      if (typeof value === 'function') value();
      return (value ?? null) as PublishedCapabilities | null;
    },
    async validateDependencyGraph(_req: DagValidationRequest): Promise<DagValidationResult> {
      const value = overrides.dag;
      if (typeof value === 'function') value();
      return (value ?? { acyclic: true, cycle: null }) as DagValidationResult;
    },
  };
}

/** A schema-valid manifest the cases mutate. */
function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: '1.0',
    tag: 'acme-chart',
    kind: 'widget',
    name: 'Sales Chart',
    publisher: 'acme',
    version: '2.0.0',
    entry: 'widget.js',
    ...over,
  };
}

/** Build a registry check context around a manifest + fake client. */
function ctx(m: unknown, client: RegistryClient): RegistryCheckContext {
  return { manifest: m, registry: 'https://registry.example.test', client };
}

describe('capability.diff', () => {
  it('defers (emits nothing) when the manifest has no string tag', async () => {
    const m = manifest();
    delete m.tag;
    expect(await capabilityDiffCheck.run(ctx(m, fakeClient()))).toEqual([]);
  });

  it('passes on a first publish (registry has no prior version)', async () => {
    const results = await capabilityDiffCheck.run(ctx(manifest({ capabilities: [{ api: 'net', scope: 'a.example.com' }] }), fakeClient({ capabilities: null })));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'capability.diff', status: 'pass' });
    expect(results[0]?.message).toContain('first publish');
  });

  it('warns per added capability and says it will re-trigger review', async () => {
    const prior: PublishedCapabilities = { tag: 'acme-chart', version: '1.0.0', capabilities: [{ api: 'net', scope: 'a.example.com' }] };
    const m = manifest({ capabilities: [{ api: 'net', scope: 'a.example.com' }, { api: 'records.read' }] });
    const results = await capabilityDiffCheck.run(ctx(m, fakeClient({ capabilities: prior })));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'capability.diff', status: 'warn' });
    expect(results[0]?.message).toContain('records.read');
    expect(results[0]?.message).toContain('will re-trigger review');
    expect(results[0]?.message).toContain('v1.0.0');
    expect(results[0]?.hint).toContain('3d re-review');
  });

  it('emits one warn per newly-added capability', async () => {
    const prior: PublishedCapabilities = { tag: 'acme-chart', version: '1.0.0', capabilities: [] };
    const m = manifest({ capabilities: [{ api: 'net', scope: 'a.example.com' }, { api: 'events' }] });
    const results = await capabilityDiffCheck.run(ctx(m, fakeClient({ capabilities: prior })));
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'warn')).toBe(true);
    expect(results.map((r) => r.message).join('\n')).toContain('net:a.example.com');
    expect(results.map((r) => r.message).join('\n')).toContain('events');
  });

  it('passes when capabilities are unchanged', async () => {
    const caps = [{ api: 'net', scope: 'a.example.com' }];
    const prior: PublishedCapabilities = { tag: 'acme-chart', version: '1.0.0', capabilities: caps };
    const results = await capabilityDiffCheck.run(ctx(manifest({ capabilities: caps }), fakeClient({ capabilities: prior })));
    expect(results).toEqual([{ id: 'capability.diff', status: 'pass', message: 'no capability increase vs the last published version (v1.0.0)' }]);
  });

  it('passes on a pure decrease (removing a capability is not a re-review trigger)', async () => {
    const prior: PublishedCapabilities = { tag: 'acme-chart', version: '1.0.0', capabilities: [{ api: 'net', scope: 'a.example.com' }, { api: 'events' }] };
    const results = await capabilityDiffCheck.run(ctx(manifest({ capabilities: [{ api: 'events' }] }), fakeClient({ capabilities: prior })));
    expect(results[0]).toMatchObject({ status: 'pass' });
  });

  it('warns (never wrongly passes) when the registry cannot be reached', async () => {
    const client = fakeClient({ capabilities: () => { throw new Error('ECONNREFUSED'); } });
    const results = await capabilityDiffCheck.run(ctx(manifest({ capabilities: [{ api: 'net', scope: 'a.example.com' }] }), client));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'capability.diff', status: 'warn' });
    expect(results[0]?.message).toContain('ECONNREFUSED');
  });

  it('maps to the capability re-review tier (3d)', () => {
    expect(tierForCheckId('capability.diff').id).toBe('reReview');
    expect(tierForCheckId('capability.diff').sla).toBe('3d');
  });
});

describe('deps.server-acyclic', () => {
  it('defers when the manifest has no string tag', async () => {
    const m = manifest({ requires: [{ tag: 'acme-legend', range: '^1.0.0' }] });
    delete m.tag;
    expect(await serverDagCheck.run(ctx(m, fakeClient()))).toEqual([]);
  });

  it('defers when requires is absent or not an array', async () => {
    expect(await serverDagCheck.run(ctx(manifest(), fakeClient()))).toEqual([]);
    expect(await serverDagCheck.run(ctx(manifest({ requires: 'nope' }), fakeClient()))).toEqual([]);
  });

  it('passes without a network call when there are no requirements', async () => {
    let called = false;
    const client: RegistryClient = {
      ...fakeClient(),
      async validateDependencyGraph() { called = true; return { acyclic: true }; },
    };
    const results = await serverDagCheck.run(ctx(manifest({ requires: [] }), client));
    expect(called).toBe(false);
    expect(results[0]).toMatchObject({ id: 'deps.server-acyclic', status: 'pass' });
  });

  it('passes when the registry reports the graph acyclic', async () => {
    const results = await serverDagCheck.run(ctx(manifest({ requires: [{ tag: 'acme-legend', range: '^1.0.0' }] }), fakeClient({ dag: { acyclic: true, cycle: null } })));
    expect(results).toEqual([{ id: 'deps.server-acyclic', status: 'pass', message: 'dependency graph is acyclic against the registry (1 requirement(s))' }]);
  });

  it('fails and prints the cycle path when the registry reports a cycle', async () => {
    const dag: DagValidationResult = { acyclic: false, cycle: ['acme-chart', 'other-grid', 'acme-chart'] };
    const results = await serverDagCheck.run(ctx(manifest({ requires: [{ tag: 'other-grid', range: '^2.0.0' }] }), fakeClient({ dag })));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'deps.server-acyclic', status: 'fail' });
    expect(results[0]?.message).toContain('acme-chart → other-grid → acme-chart');
    expect(results[0]?.hint).toBeDefined();
  });

  it('fails with a fallback path when a cycle carries no explicit path', async () => {
    const results = await serverDagCheck.run(ctx(manifest({ requires: [{ tag: 'other-grid' }] }), fakeClient({ dag: { acyclic: false } })));
    expect(results[0]).toMatchObject({ status: 'fail' });
    expect(results[0]?.message).toContain('acme-chart');
  });

  it('warns (never wrongly passes) when the registry cannot be reached', async () => {
    const client = fakeClient({ dag: () => { throw new Error('ETIMEDOUT'); } });
    const results = await serverDagCheck.run(ctx(manifest({ requires: [{ tag: 'other-grid' }] }), client));
    expect(results[0]).toMatchObject({ id: 'deps.server-acyclic', status: 'warn' });
    expect(results[0]?.message).toContain('ETIMEDOUT');
  });

  it('maps to the automated review tier, like the offline deps.acyclic', () => {
    expect(tierForCheckId('deps.server-acyclic').id).toBe('automated');
  });
});

describe('runRegistryChecks', () => {
  it('runs every registry-aware check and flattens the findings', async () => {
    const prior: PublishedCapabilities = { tag: 'acme-chart', version: '1.0.0', capabilities: [] };
    const results = await runRegistryChecks(
      ctx(manifest({ capabilities: [{ api: 'events' }], requires: [{ tag: 'other-grid' }] }), fakeClient({ capabilities: prior, dag: { acyclic: true } })),
    );
    const ids = results.map((r) => r.id);
    expect(ids).toContain('capability.diff');
    expect(ids).toContain('deps.server-acyclic');
  });

  it('maps every registered registry check group to a tier explicitly', () => {
    for (const check of registryChecks) {
      const group = check.id.split('.')[0] ?? '';
      expect(TIER_BY_GROUP, `registry check ${check.id} group "${group}" is unmapped`).toHaveProperty(group);
    }
  });
});
