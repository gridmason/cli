/**
 * The **registry-aware** review checks (SPEC §5 checks 3–4, FR-12) — the two
 * checks `gridmason lint --registry <url>` adds on top of the offline checks:
 *
 * - `capability.diff` — diff the working manifest's declared capabilities against
 *   the **last published version** on the target registry; a capability *increase*
 *   is reported as a `warn`: "will re-trigger review" (registry §4 — a capability
 *   increase resets the review SLA to the 3d re-review lane).
 * - `deps.server-acyclic` — submit the manifest's `requires` graph to the registry
 *   for validation against its **live transitive graph** (registry §7), so a cycle
 *   that only appears against the server's view of other publishers' packages
 *   `fail`s in CI, not at publish. The local `deps.acyclic` check can only catch a
 *   self-dependency; this closes the transitive, cross-manifest case.
 *
 * These are **not** part of the offline {@link import('./run.js').checks} array the
 * registry service imports verbatim: they *call* the registry, so they cannot run
 * inside it, and they are asynchronous (network I/O) where the offline checks are
 * pure. They share everything else, though — the {@link CheckResult} shape, the
 * dotted `<group>.<slug>` check-id scheme, and the tier mapping — so a `--registry`
 * finding lands in the same `--json` report and maps to a review tier exactly like
 * its offline counterparts (SPEC §8, "no divergent server/local vocabulary").
 *
 * A registry check is fail-*safe*, not fail-closed: a transport or protocol error
 * (an unreachable registry, a malformed response) is a `warn`, never a `fail` on a
 * guess. Only a definite signal fails — a registry-confirmed cycle. The authority
 * is the registry's own publish-time gate; these checks surface its likely verdict
 * early, they do not replace it.
 */
import { formatCapability, type Capability, type CapabilityApi } from '@gridmason/protocol';
import type { RawCapability, CheckResult } from './types.js';
import type { RegistryClient, RequiresEdge } from './registry-client.js';

/** A plain, non-null, non-array object (for reading the untrusted manifest defensively). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Everything a registry-aware check reads. Built by the CLI (`gridmason lint
 * --registry`): the parsed manifest, the registry URL (for messages), and the
 * {@link RegistryClient} that fetches from it — injected so a check is a function
 * of its input and testable against a fake, exactly like the offline checks.
 */
export interface RegistryCheckContext {
  /** The parsed `manifest.json` under review — untrusted, read defensively. */
  readonly manifest: unknown;
  /** The target registry URL (`--registry`), for source-qualifying a finding's message. */
  readonly registry: string;
  /** The client the check reads the registry through — the network seam. */
  readonly client: RegistryClient;
}

/**
 * A registry-aware check: the same stable identity + metadata as an offline
 * {@link import('./types.js').Check}, but with an **async** {@link run} over a
 * {@link RegistryCheckContext} (it calls the registry). It never throws — a call
 * that fails becomes a `warn` finding.
 */
export interface RegistryCheck {
  /** Stable, dotted check id (`<group>.<slug>`), echoed by every result and shared with the offline scheme. */
  readonly id: string;
  /** Short human title for output headers and the reference page. */
  readonly title: string;
  /** Why this check exists — seeds the reference page (docs/checks.md). */
  readonly rationale: string;
  /** Run the check against `ctx`, returning its findings (never throws). */
  run(ctx: RegistryCheckContext): Promise<CheckResult[]>;
}

/** The canonical `api[:scope]` string for a raw capability — the protocol's own formatting, so a diff key matches review's. */
function canonicalCapability(cap: RawCapability): string {
  const typed: Capability = cap.scope !== undefined ? { api: cap.api as CapabilityApi, scope: cap.scope } : { api: cap.api as CapabilityApi };
  return formatCapability(typed);
}

/** Read the well-shaped `{ api: string, scope?: string }` capabilities out of an untrusted manifest. */
function manifestCapabilities(manifest: unknown): RawCapability[] {
  const value = isObject(manifest) ? manifest.capabilities : undefined;
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

/** The manifest's own tag, or `undefined` when it is not a string (manifest.tag/schema owns that). */
function manifestTag(manifest: unknown): string | undefined {
  return isObject(manifest) && typeof manifest.tag === 'string' ? manifest.tag : undefined;
}

/**
 * `capability.diff` — the capability diff against the last published version (SPEC
 * §5 check 3). Defers (emits nothing) when the manifest has no string `tag`
 * (`manifest.tag`/`manifest.schema` own that). On a first publish (the registry has
 * no prior version) there is nothing to diff — a `pass`. Each capability present
 * now but absent from the last published version is an **increase**, reported as a
 * `warn`: it re-triggers review (registry §4). A capability *removed* is not a
 * re-review trigger, so a pure decrease passes. A registry that cannot be reached
 * yields a single `warn` — the diff is unknown, never wrongly clean.
 */
export const capabilityDiffCheck: RegistryCheck = {
  id: 'capability.diff',
  title: 'capability diff',
  rationale:
    'A capability increase over the last published version re-triggers registry review (registry §4), ' +
    'resetting the review SLA. This check fetches the previously-published capabilities from the target ' +
    'registry and flags each added capability so the author learns the change resets the SLA before publishing.',
  async run(ctx): Promise<CheckResult[]> {
    const tag = manifestTag(ctx.manifest);
    // No well-formed tag: manifest.tag / manifest.schema report that, not this check.
    if (tag === undefined) {
      return [];
    }
    let prior;
    try {
      prior = await ctx.client.publishedCapabilities(tag);
    } catch (err) {
      return [
        {
          id: this.id,
          status: 'warn',
          message: `could not read the capability history of "${tag}" from ${ctx.registry}: ${(err as Error).message}`,
          hint: 'the capability diff is a pre-publish aid; the registry runs the authoritative diff at publish (registry §4)',
        },
      ];
    }
    // First publish: no prior version to diff against.
    if (prior === null) {
      return [
        {
          id: this.id,
          status: 'pass',
          message: `"${tag}" has no previously-published version on ${ctx.registry} — first publish, nothing to diff`,
        },
      ];
    }
    const priorSet = new Set(prior.capabilities.map(canonicalCapability));
    const current = manifestCapabilities(ctx.manifest);
    const added = current.map(canonicalCapability).filter((cap) => !priorSet.has(cap));
    if (added.length > 0) {
      return added.map((cap) => ({
        id: this.id,
        status: 'warn' as const,
        message: `capability increase vs the last published version (v${prior.version}): "${cap}" is new — will re-trigger review`,
        hint: 'a capability increase resets the review SLA (registry §4, 3d re-review); declare only what the widget needs',
      }));
    }
    return [
      {
        id: this.id,
        status: 'pass',
        message: `no capability increase vs the last published version (v${prior.version})`,
      },
    ];
  },
};

/**
 * `deps.server-acyclic` — the server-validated dependency-DAG check (SPEC §5 check
 * 4 with `--registry`). Defers when the manifest has no string `tag` or its
 * `requires` is not an array (`manifest.schema`/`deps.acyclic` own those shapes).
 * With no requirements the node has no outgoing edges and cannot be in a cycle — a
 * `pass` with no network call. Otherwise it submits the `requires` graph to the
 * registry, which merges it into its live transitive graph: a confirmed cycle is a
 * `fail` (the cycle path is printed, the same `a → … → a` form as `deps.acyclic`);
 * an unreachable/malformed registry is a `warn`, deferring to the publish-time gate.
 */
export const serverDagCheck: RegistryCheck = {
  id: 'deps.server-acyclic',
  title: 'server dependency DAG',
  rationale:
    "The registry rejects a cyclic `requires` graph at publish (registry §7). The local deps.acyclic check " +
    'sees only this manifest, so it can prove no more than a self-dependency; this check submits the graph to ' +
    'the target registry for validation against its live transitive graph, catching a cross-manifest cycle in ' +
    'CI rather than at publish.',
  async run(ctx): Promise<CheckResult[]> {
    const tag = manifestTag(ctx.manifest);
    if (tag === undefined) {
      return [];
    }
    const requires = isObject(ctx.manifest) ? ctx.manifest.requires : undefined;
    // Absent/non-array `requires`: no graph to submit (manifest.schema owns the shape).
    if (!Array.isArray(requires)) {
      return [];
    }
    const edges: RequiresEdge[] = [];
    for (const req of requires) {
      if (isObject(req) && typeof req.tag === 'string') {
        edges.push(typeof req.range === 'string' ? { tag: req.tag, range: req.range } : { tag: req.tag });
      }
    }
    // No edges from this node: it cannot close a cycle — trivially acyclic, no call needed.
    if (edges.length === 0) {
      return [{ id: this.id, status: 'pass', message: 'no dependencies declared — nothing to validate against the registry' }];
    }
    let result;
    try {
      result = await ctx.client.validateDependencyGraph({ tag, requires: edges });
    } catch (err) {
      return [
        {
          id: this.id,
          status: 'warn',
          message: `could not validate the dependency graph against ${ctx.registry}: ${(err as Error).message}`,
          hint: 'the server DAG check is a pre-publish aid; the registry runs the authoritative acyclicity gate at publish (registry §7)',
        },
      ];
    }
    if (!result.acyclic) {
      const path = result.cycle && result.cycle.length > 0 ? result.cycle.join(' → ') : `${tag} → … → ${tag}`;
      return [
        {
          id: this.id,
          status: 'fail',
          message: `dependency cycle detected against the registry graph: ${path}`,
          hint: 'break the cycle — a widget must not (transitively) require itself (registry §7)',
        },
      ];
    }
    return [
      {
        id: this.id,
        status: 'pass',
        message: `dependency graph is acyclic against the registry (${edges.length} requirement(s))`,
      },
    ];
  },
};

/** The registry-aware checks (SPEC §5 checks 3–4), in report order. */
export const registryChecks: readonly RegistryCheck[] = [capabilityDiffCheck, serverDagCheck];

/**
 * Run `toRun` (every registry-aware check by default) against `ctx` and collect
 * their findings in check order. The checks are independent, so they run
 * concurrently; a check never throws, so this never does.
 */
export async function runRegistryChecks(
  ctx: RegistryCheckContext,
  toRun: readonly RegistryCheck[] = registryChecks,
): Promise<CheckResult[]> {
  const grouped = await Promise.all(toRun.map((check) => check.run(ctx)));
  return grouped.flat();
}
