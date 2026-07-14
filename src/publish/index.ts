/**
 * The publish path (SPEC §7, Phase B) — placeholder skeleton. Orchestrates
 * keyless Sigstore-style signing bound to the `login` OIDC identity, upload of
 * the content-hashed artifact to a registry Publish API, review-status polling,
 * and `appeal`. The CLI holds no bespoke crypto and, by keyless default, no
 * long-lived key. The L-E3 epic (#15-#17) fills this in.
 */

/** A poll of registry review state after upload. Shape grows as publish lands. */
export interface ReviewStatus {
  status: 'pending' | 'passed' | 'failed';
}
