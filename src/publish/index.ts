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
  acquireIdentity,
  decodeOidcToken,
  resolveIdentity,
  selectProvider,
  sigstoreInstance,
  toPublisherIdentity,
} from './identity.js';
export type {
  AcquiredIdentity,
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

// The publish path (SPEC §7, §8; FR-11): artifact assembly, keyless signing,
// the registry Publish API client, and the publish/appeal orchestration.
export { assembleArtifact } from './artifact.js';
export type { Artifact, ArtifactFile, AssembleErrorCode, AssembleResult, FileRole } from './artifact.js';
export { ARTIFACT_PAYLOAD_TYPE, ephemeralSigner, sigstoreSigner } from './signing.js';
export type { ArtifactSigner, ArtifactSubject, DsseEnvelope, SignRequest } from './signing.js';
export { fetchTransport, MAX_RESPONSE_BYTES } from './transport.js';
export type { HttpResponse, RequestOptions, Transport } from './transport.js';
export { appealArtifact, getReviewStatus, uploadArtifact } from './upload.js';
export type {
  ArtifactRecord,
  ArtifactState,
  ClientResult,
  RegistryClientDeps,
  RegistryError,
  ReviewFinding,
  ReviewStatus,
  UploadRequest,
} from './upload.js';
export { MANUAL_FINDING, mapFindings } from './findings.js';
export type { MappedFinding } from './findings.js';
export { runPublish } from './run.js';
export type { PublishArgs, PublishDeps } from './run.js';
export { runAppeal } from './appeal.js';
export type { AppealArgs, AppealDeps } from './appeal.js';
