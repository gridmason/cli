/**
 * Map registry review findings back onto the **shared `src/checks` vocabulary**
 * (SPEC §7: "print the reviewer's findings mapped to the same `lint` check ids").
 * A finding names a check id — the identical id `gridmason lint` prints locally —
 * so this looks the check up in the shared registry to attach its human title and
 * the review tier it feeds, and renders the `manual` sentinel (a hand-made
 * reviewer judgement, registry docs/review/human-lane.md) as its own line. This is
 * the whole point of the one-implementation checks module: server findings and
 * local lint speak one language, so an author fixes review failures with the same
 * check ids they already know.
 */
import { checks, tierForCheckId } from '../checks/index.js';
import type { ReviewFinding } from './upload.js';

/** The `checkId` a reviewer uses for a judgement made by hand, not tied to a check. */
export const MANUAL_FINDING = 'manual';

/** A finding resolved to its shared-check metadata for display. */
export interface MappedFinding {
  /** The shared check id, or {@link MANUAL_FINDING}. */
  readonly checkId: string;
  /** The check's human title (`SDK raw-network`), or `manual review` for a hand finding. */
  readonly title: string;
  /** The review tier the check feeds (`automated` / `TF` / …); absent for `manual`. */
  readonly tier?: string;
  /** The reviewer's / automated detail for this finding. */
  readonly detail: string;
  /** The finding's severity when the source carried one. */
  readonly status?: 'pass' | 'warn' | 'fail';
}

const CHECK_BY_ID = new Map(checks.map((c) => [c.id, c] as const));

/**
 * Resolve each {@link ReviewFinding} to its shared-check metadata. A known check
 * id gets its title + tier; the `manual` sentinel is rendered as a hand review; an
 * unrecognized id (a check the local module does not know — e.g. a newer server
 * check) is passed through with its id as the title, never dropped.
 */
export function mapFindings(findings: readonly ReviewFinding[]): MappedFinding[] {
  return findings.map((f) => {
    if (f.checkId === MANUAL_FINDING) {
      return { checkId: f.checkId, title: 'manual review', detail: f.detail, ...(f.status ? { status: f.status } : {}) };
    }
    const check = CHECK_BY_ID.get(f.checkId);
    return {
      checkId: f.checkId,
      title: check ? check.title : f.checkId,
      tier: tierForCheckId(f.checkId).id,
      detail: f.detail,
      ...(f.status ? { status: f.status } : {}),
    };
  });
}
