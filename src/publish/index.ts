/**
 * The publish path (SPEC §7, Phase B). Orchestrates keyless Sigstore-style
 * signing bound to the `login` OIDC identity, upload of the content-hashed
 * artifact to a registry Publish API, review-status polling, and `appeal`. The
 * CLI holds no bespoke crypto and, by keyless default, no long-lived key.
 *
 * Landed: the shared **signing identity** plumbing (`login`/`whoami`, issue #15) —
 * the OIDC identity `publish` binds a short-lived certificate to and mirrors into
 * the signature envelope (protocol §4.2). Upload + review polling + `appeal`
 * (#16–#17) fill in the rest of the L-E3 epic.
 */

export {
  IdentityError,
  PRODUCTION_INSTANCE,
  SIGSTORE_AUDIENCE,
  STAGING_INSTANCE,
  decodeOidcToken,
  resolveIdentity,
  selectProvider,
  sigstoreInstance,
  toPublisherIdentity,
} from './identity.js';
export type {
  IdentityErrorCode,
  IdentityProvider,
  OidcIdentity,
  ResolveOptions,
  SigstoreInstance,
} from './identity.js';
export { clearSession, configDir, readSession, sessionPath, toSession, writeSession } from './session.js';
export type { Session } from './session.js';
export { reportIdentityError, runLogin } from './login.js';
export type { LoginOptions } from './login.js';
export { runWhoami } from './whoami.js';
export type { WhoamiOptions } from './whoami.js';

/** A poll of registry review state after upload. Shape grows as publish lands. */
export interface ReviewStatus {
  status: 'pending' | 'passed' | 'failed';
}
