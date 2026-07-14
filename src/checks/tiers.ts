/**
 * Check-id → registry review-tier mapping (SPEC §5, FR-7; registry §4.1–§4.2).
 *
 * `gridmason lint --json` maps **every** check id to the registry review tier its
 * findings feed, so a CI consumer learns which review SLA the artifact will hit
 * before it publishes (SPEC §5, "Every check maps to a registry review tier"). The
 * relation is deliberately **data-driven** and keyed by the check-id `<group>`
 * prefix (the `manifest` / `sdk` / `deps` / `dom` families from `docs/checks.md`),
 * so a new check family maps with a one-line addition to {@link TIER_BY_GROUP}.
 *
 * The tiers themselves are the registry's own (registry §4.2), imported as data,
 * not re-invented: the shared checks module is what the registry runs verbatim
 * (SPEC §8), so lint and registry agree on which tier a check belongs to as much
 * as they agree on the check itself.
 */

/**
 * A registry review tier — the stage a finding is reviewed under and, where a
 * human tier applies, its flagship SLA (registry §4.2). Additive: a reserved
 * compute/container tier (registry §4.2) adds an entry without breaking consumers.
 */
export interface ReviewTier {
  /** Stable tier id, echoed by a report result's `tier` and keyed in the report `tiers` catalog. */
  readonly id: string;
  /** Human label for output and the report (`frontend remote`). */
  readonly title: string;
  /** Flagship review SLA (`5d`); absent for the automated stage, which is synchronous at publish. */
  readonly sla?: string;
  /** Where the tier is defined, so a report reader can trace it (`registry §4.2`). */
  readonly reference: string;
}

/**
 * The registry's review tiers (registry §4.1–§4.2), keyed by id:
 *
 * - `automated` — the automated review stage every publish runs (manifest lint,
 *   dependency-DAG, capability diff, malicious-code + SDK-adherence analysis;
 *   registry §4.1). It gates *before* any human tier, so it carries no human SLA.
 * - `T1` — declarative artifacts with no executable content (layouts, page types,
 *   dashboards; registry §4.2). Flagship SLA 2d. No v0 check family targets it yet
 *   — it is kept here so the report's tier catalog documents the full surface.
 * - `TF` — frontend remotes, the common widget case: SDK-adherence static analysis
 *   + DOM-abuse heuristics (registry §4.2). Flagship SLA 5d.
 */
export const REVIEW_TIERS = {
  automated: { id: 'automated', title: 'automated review', reference: 'registry §4.1' },
  T1: { id: 'T1', title: 'declarative', sla: '2d', reference: 'registry §4.2' },
  TF: { id: 'TF', title: 'frontend remote', sla: '5d', reference: 'registry §4.2' },
} as const satisfies Record<string, ReviewTier>;

/** A known tier id. */
export type ReviewTierId = keyof typeof REVIEW_TIERS;

/**
 * Which review tier a check-id `<group>` feeds. The data-driven core of the
 * mapping: the manifest lint and the dependency-DAG check are automated-stage
 * gates (registry §4.1); the SDK-adherence (`sdk`) and DOM-abuse (`dom`) families
 * are the frontend-remote human review (registry §4.2). #12's `sdk.*` / `dom.*`
 * checks map here with no further change; a new family is one line.
 */
export const TIER_BY_GROUP: Readonly<Record<string, ReviewTierId>> = {
  manifest: 'automated',
  deps: 'automated',
  sdk: 'TF',
  dom: 'TF',
};

/**
 * The tier a check-id maps to when its `<group>` is not in {@link TIER_BY_GROUP}:
 * the automated stage, the floor every publish hits (registry §4.1). A genuinely
 * new family should be added to the table (a test asserts every registered check
 * is mapped explicitly), so this is a safe default, not the intended path.
 */
const DEFAULT_TIER: ReviewTierId = 'automated';

/**
 * The registry review {@link ReviewTier} a check id feeds, by its `<group>` prefix
 * (`manifest.schema` → `manifest` → the automated stage). Total — an unmapped
 * group falls back to {@link DEFAULT_TIER}.
 */
export function tierForCheckId(id: string): ReviewTier {
  const group = id.split('.')[0] ?? '';
  return REVIEW_TIERS[TIER_BY_GROUP[group] ?? DEFAULT_TIER];
}
