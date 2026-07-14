/**
 * Dependency-DAG lint — the local acyclicity check (SPEC §5.4, FR-7). The
 * manifest's `requires` array is a set of dependency-DAG edges (protocol §3.1:
 * `{ tag, range }`); the registry rejects cycles at publish, so surfacing a cycle
 * locally fails it in CI, not at upload (SPEC §5, §8).
 *
 * This is the **local / offline** check: it sees one manifest, so the only cycle
 * it can prove is a widget that (directly) requires **its own tag** — a
 * self-dependency. Transitive, cross-manifest cycles need the registry to resolve
 * the rest of the graph; that is `lint --registry` server-side validation (SPEC
 * §5, Phase B, #19). The cycle finder here is written over a general graph so the
 * registry path reuses the identical algorithm (SPEC §8, "one implementation").
 */
import type { Check, CheckResult } from './types.js';

/** A plain, non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Find the first cycle in a dependency graph keyed by tag, returning it as a path
 * `[a, b, …, a]` — the repeated final node closes the loop — or `undefined` when
 * the graph is acyclic. Nodes reached only as edge targets (a required tag with no
 * entry of its own) are treated as leaves. Pure and total: a depth-first search
 * with a gray/black colouring, no throw on any input.
 *
 * Local `lint` hands it a one-node graph (`tag → requires[].tag`), where the only
 * detectable cycle is a self-edge; the registry's transitive resolution (#19)
 * hands it the full graph — one implementation for both (SPEC §8).
 */
export function findRequiresCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  type Colour = 'gray' | 'black';
  const colour = new Map<string, Colour>();
  const stack: string[] = [];

  function visit(node: string): string[] | undefined {
    colour.set(node, 'gray');
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const seen = colour.get(next);
      if (seen === 'gray') {
        // Back-edge to a node still on the stack: the cycle is that node through
        // the current tip, closed by repeating it.
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (seen === undefined) {
        const cycle = visit(next);
        if (cycle) {
          return cycle;
        }
      }
    }
    stack.pop();
    colour.set(node, 'black');
    return undefined;
  }

  for (const node of graph.keys()) {
    if (colour.get(node) === undefined) {
      const cycle = visit(node);
      if (cycle) {
        return cycle;
      }
    }
  }
  return undefined;
}

/**
 * `deps.acyclic` — the manifest's `requires` graph is acyclic. Defers (emits
 * nothing) when `requires` is absent or not an array (no graph, or a shape
 * `manifest.schema` owns) and when the root `tag` is not a string (the anchor
 * `manifest.tag` owns). Malformed requirement entries are skipped — their shape is
 * `manifest.schema`'s to report — so this check only ever fails on a real cycle.
 */
export const dependencyDagCheck: Check = {
  id: 'deps.acyclic',
  title: 'dependency DAG',
  rationale:
    "The manifest's `requires` entries are dependency-DAG edges, and the registry rejects a cyclic " +
    'graph at publish. This check proves acyclicity locally so a cycle fails in CI, not at upload. ' +
    'Offline it can only catch a widget that requires its own tag; transitive cycles are the ' +
    'registry-validated `lint --registry` job (SPEC §5.4).',
  run(ctx): CheckResult[] {
    const manifest = isObject(ctx.manifest) ? ctx.manifest : {};
    const requires = manifest.requires;
    // Absent or non-array `requires`: no graph to check (a non-array shape is
    // manifest.schema's to report).
    if (!Array.isArray(requires)) {
      return [];
    }
    const rootTag = typeof manifest.tag === 'string' ? manifest.tag : undefined;
    // Without a well-formed root tag the graph has no anchor; manifest.tag owns that.
    if (rootTag === undefined) {
      return [];
    }
    // Only well-shaped `{ tag: string }` requirements become edges; the rest are
    // manifest.schema's to fail on, not this check's to double-report.
    const edges: string[] = [];
    for (const req of requires) {
      if (isObject(req) && typeof req.tag === 'string') {
        edges.push(req.tag);
      }
    }
    const cycle = findRequiresCycle(new Map([[rootTag, edges]]));
    if (cycle !== undefined) {
      return [
        {
          id: this.id,
          status: 'fail',
          message: `dependency cycle detected: ${cycle.join(' → ')}`,
          hint: 'break the cycle — a widget must not (transitively) require itself',
        },
      ];
    }
    return [
      {
        id: this.id,
        status: 'pass',
        message:
          edges.length > 0
            ? `dependency graph is acyclic (${edges.length} requirement(s))`
            : 'no dependencies declared',
      },
    ];
  },
};

/** The dependency-DAG checks (SPEC §5.4), in report order. */
export const dependencyChecks: readonly Check[] = [dependencyDagCheck];
