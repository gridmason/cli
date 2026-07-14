/**
 * Dependency-DAG check tests (SPEC §5.4, FR-7): the local acyclicity check and the
 * general cycle finder it reuses. The check sees one manifest, so the cycle it can
 * prove is a self-dependency (a widget requiring its own tag); the finder is tested
 * over richer graphs so the registry path (#19) inherits a proven algorithm.
 */
import { describe, expect, it } from 'vitest';
import {
  checks,
  dependencyDagCheck,
  findRequiresCycle,
  runChecks,
  tierForCheckId,
  type CheckContext,
} from '../src/checks/index.js';

/** A schema-valid manifest the cases mutate; only `requires` varies. */
function baseManifest(requires?: unknown): Record<string, unknown> {
  return {
    formatVersion: '1.0',
    tag: 'acme-chart',
    kind: 'widget',
    name: 'Sales Chart',
    publisher: 'acme',
    version: '1.0.0',
    entry: 'widget.js',
    ...(requires !== undefined ? { requires } : {}),
  };
}

describe('findRequiresCycle', () => {
  it('returns undefined for an acyclic graph', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b', 'c']],
      ['b', ['c']],
      ['c', []],
    ]);
    expect(findRequiresCycle(graph)).toBeUndefined();
  });

  it('finds a self-loop as a two-node path', () => {
    expect(findRequiresCycle(new Map([['a', ['a']]]))).toEqual(['a', 'a']);
  });

  it('finds a multi-node cycle and closes the path on the repeated node', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    const cycle = findRequiresCycle(graph);
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
    expect(cycle).toEqual(['a', 'b', 'c', 'a']);
  });

  it('treats a required node with no entry of its own as a leaf', () => {
    // `b` is only ever a target — no outgoing edges, so no cycle.
    expect(findRequiresCycle(new Map([['a', ['b']]]))).toBeUndefined();
  });
});

describe('deps.acyclic check', () => {
  it('passes and enumerates the requirement count for an acyclic graph', () => {
    const results = dependencyDagCheck.run({
      manifest: baseManifest([
        { tag: 'acme-legend', range: '^1.0.0' },
        { tag: 'other-grid', range: '^2.0.0' },
      ]),
    });
    expect(results).toEqual([
      { id: 'deps.acyclic', status: 'pass', message: 'dependency graph is acyclic (2 requirement(s))' },
    ]);
  });

  it('passes with "no dependencies declared" for an empty requires array', () => {
    const results = dependencyDagCheck.run({ manifest: baseManifest([]) });
    expect(results).toEqual([{ id: 'deps.acyclic', status: 'pass', message: 'no dependencies declared' }]);
  });

  it('fails and prints the cycle path when a widget requires its own tag', () => {
    const results = dependencyDagCheck.run({
      manifest: baseManifest([{ tag: 'acme-chart', range: '^1.0.0' }]),
    });
    expect(results).toHaveLength(1);
    const [finding] = results;
    expect(finding).toMatchObject({ id: 'deps.acyclic', status: 'fail' });
    expect(finding?.message).toContain('dependency cycle detected: acme-chart → acme-chart');
    expect(finding?.hint).toBeDefined();
  });

  it('defers (emits nothing) when requires is absent or not an array', () => {
    expect(dependencyDagCheck.run({ manifest: baseManifest() })).toEqual([]);
    expect(dependencyDagCheck.run({ manifest: baseManifest('not-an-array') })).toEqual([]);
  });

  it('defers when the root tag is not a string (manifest.tag owns that)', () => {
    const manifest = baseManifest([{ tag: 'acme-chart', range: '^1.0.0' }]);
    delete manifest.tag;
    expect(dependencyDagCheck.run({ manifest })).toEqual([]);
  });

  it('skips malformed requirement entries rather than double-reporting shape', () => {
    const results = dependencyDagCheck.run({
      manifest: baseManifest([{ range: '^1.0.0' }, 'nope', { tag: 'acme-chart', range: '^1.0.0' }]),
    });
    // The one well-formed entry is a self-edge → still a cycle; the malformed
    // entries are manifest.schema's to report, not this check's.
    expect(results[0]).toMatchObject({ status: 'fail' });
    expect(results[0]?.message).toContain('acme-chart → acme-chart');
  });

  it('runs as a registered check and maps to the automated review tier', () => {
    const ctx: CheckContext = { manifest: baseManifest([{ tag: 'acme-chart', range: '^1.0.0' }]) };
    const ids = runChecks(ctx).map((r) => r.id);
    expect(ids).toContain('deps.acyclic');
    expect(checks.some((c) => c.id === 'deps.acyclic')).toBe(true);
    expect(tierForCheckId('deps.acyclic').id).toBe('automated');
  });
});
