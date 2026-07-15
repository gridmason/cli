/**
 * Keyless artifact signing (SPEC §7, §8): `publish` binds a short-lived signature
 * to the OIDC identity `login` established and produces the **publisher half of
 * the `@gridmason/protocol` `SignatureEnvelope`** — `{ formatVersion, subject{
 * artifact, releaseHash }, publisherSig{ alg, cert, issuer, subjectClaims, sig } }`
 * — over the canonical release subject. The registry Publish API validates that
 * shape and its countersign stage applies the approval half; a host verifies both
 * against `@gridmason/protocol` before loading (registry `docs/api/publish.md`,
 * "Signature envelope"; owner decision on gridmason/cli#70 — the CLI emits the
 * protocol envelope, not a bare DSSE object).
 *
 * `releaseHash` binds the signature to the exact served bytes: it is the SHA-256
 * multihash of the canonical (RFC-8785) release document `{ formatVersion,
 * artifact, files }` whose `files` is the `{ path → content-hash }` map — the same
 * document the registry countersign reproduces and checks the signature against,
 * so producer and verifier agree on "the bytes".
 *
 * The CLI holds **no bespoke crypto** beyond assembling this wire shape, and keeps
 * no long-lived key:
 *
 * - {@link sigstoreSigner} is the production path — `@sigstore/sign`'s
 *   {@link FulcioSigner} mints an ephemeral keypair in memory, gets a Fulcio
 *   short-lived certificate bound to the OIDC token, and signs the subject.
 *   Nothing touches disk. It needs network + an allowlisted-issuer token, so it is
 *   exercised opt-in (like `login`'s live-staging leg), not in the offline suite.
 * - {@link ephemeralSigner} is an offline keyless signer for the dev / registry-e2e
 *   loop: a per-invocation in-memory ECDSA P-256 keypair signs the subject (ES256,
 *   IEEE-P1363) and mints a **self-issued** leaf certificate in the profile the
 *   protocol verifier parses, then is discarded — no CA, no network, no persisted
 *   key. A host pins that leaf's own SPKI as the publisher root.
 *
 * The signer is injected into `publish` (see `src/publish/run.ts`) so a test — and
 * registry CI, via `--signer ephemeral` — can drive the flow deterministically.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { FulcioSigner, type IdentityProvider } from '@sigstore/sign';
import {
  canonicalize,
  hashBytes,
  type MultihashString,
  type PublisherSignature,
  type ReleaseDoc,
  type ReleaseHashMap,
  type SignatureEnvelope,
  type SignatureSubject,
} from '@gridmason/protocol';
import type { SigstoreInstance } from './identity.js';
import { buildKeylessLeafCertificate, derEcdsaToP1363, leafPemToDerBase64 } from './keyless-cert.js';

/**
 * The release-document wire-format version and signature-envelope format version.
 * Both are part of the canonical bytes the publisher signs / the registry
 * reproduces, so producer and verifier must agree — the value the registry emits
 * (registry `src/release/release-doc.ts`, `@gridmason/protocol` §4.1/§4.2).
 */
const RELEASE_DOC_FORMAT_VERSION = '1.0';
const SIGNATURE_ENVELOPE_FORMAT_VERSION = '1.0';

/**
 * The publisher half of the protocol {@link SignatureEnvelope} — the shape the CLI
 * uploads. It omits the registry countersignature and log-inclusion transport (the
 * registry fills those at countersign); the registry's intake parses exactly this
 * subset (registry `src/countersign/countersign.ts`, `parsePublisherEnvelope`).
 */
export type PublisherSignatureEnvelope = Pick<
  SignatureEnvelope,
  'formatVersion' | 'subject' | 'publisherSig'
>;

/** What the publisher commits to: the version-qualified artifact and its content-hash map. */
export interface ArtifactSubject {
  /** Version-qualified artifact id, `<tag>@<version>`. */
  readonly artifact: string;
  /** `{ served path → content hash }` — the exact immutable bytes the signature covers. */
  readonly contentHashes: Readonly<Record<string, string>>;
  /** OIDC issuer the publisher authenticated to (the authorship trust anchor, mirrored + in the cert). */
  readonly issuer: string;
  /** Identity claims the OIDC issuer asserted (mirrored into the envelope; the cert is the anchor). */
  readonly subjectClaims: Readonly<Record<string, string>>;
}

/** One signing request: the subject to sign and the OIDC token to bind it to. */
export interface SignRequest {
  readonly subject: ArtifactSubject;
  /** The OIDC token (keyless binding); the same token authorizes the upload. */
  readonly token: string;
}

/** Signs an artifact subject into the publisher envelope. Injected into `publish` for testability. */
export interface ArtifactSigner {
  sign(request: SignRequest): Promise<PublisherSignatureEnvelope>;
}

/** The canonical release subject `{ artifact, releaseHash }` and its signable bytes. */
async function releaseSubject(
  subject: ArtifactSubject,
): Promise<{ protocolSubject: SignatureSubject; bytes: Uint8Array }> {
  const releaseDoc: ReleaseDoc = {
    formatVersion: RELEASE_DOC_FORMAT_VERSION,
    artifact: subject.artifact,
    files: subject.contentHashes as ReleaseHashMap,
  };
  const releaseHash: MultihashString = await hashBytes(canonicalize(releaseDoc));
  const protocolSubject: SignatureSubject = { artifact: subject.artifact, releaseHash };
  return { protocolSubject, bytes: canonicalize(protocolSubject) };
}

/** Assemble the publisher envelope from the signed subject and the publisher signature. */
function buildEnvelope(
  protocolSubject: SignatureSubject,
  publisherSig: PublisherSignature,
): PublisherSignatureEnvelope {
  return {
    formatVersion: SIGNATURE_ENVELOPE_FORMAT_VERSION,
    subject: protocolSubject,
    publisherSig,
  };
}

/** The SAN rfc822 identity to bind into a self-issued leaf, if the claims carry one. */
function identityEmail(subjectClaims: Readonly<Record<string, string>>): string | undefined {
  return subjectClaims.email ?? subjectClaims.sub ?? undefined;
}

/**
 * The production keyless signer: a Fulcio short-lived certificate bound to the
 * OIDC identity, plus an ECDSA signature over the canonical release subject. The
 * ephemeral signing key is minted in memory by {@link FulcioSigner} and never
 * persisted. Fulcio returns the cert as PEM and a DER signature; the envelope
 * carries the leaf's DER (base64) and the signature in IEEE-P1363 form.
 */
export function sigstoreSigner(instance: SigstoreInstance, provider: IdentityProvider): ArtifactSigner {
  return {
    async sign(request) {
      const { protocolSubject, bytes } = await releaseSubject(request.subject);
      const signer = new FulcioSigner({ fulcioBaseURL: instance.fulcioURL, identityProvider: provider });
      const result = await signer.sign(Buffer.from(bytes));
      if (result.key.$case !== 'x509Certificate') {
        throw new Error('sigstore signer did not return an X.509 certificate');
      }
      const publisherSig: PublisherSignature = {
        alg: 'ES256',
        cert: leafPemToDerBase64(result.key.certificate),
        issuer: request.subject.issuer,
        subjectClaims: request.subject.subjectClaims,
        sig: Buffer.from(derEcdsaToP1363(new Uint8Array(result.signature))).toString('base64'),
      };
      return buildEnvelope(protocolSubject, publisherSig);
    },
  };
}

/**
 * An offline keyless signer for the dev / registry-e2e loop (no Sigstore, no
 * network): a fresh in-memory ECDSA P-256 keypair signs the canonical subject
 * (ES256, IEEE-P1363) and self-issues a leaf certificate in the profile the
 * protocol verifier parses (Fulcio issuer extension = the OIDC issuer, SAN =
 * the identity email), then is discarded — no CA, no persisted key. The envelope
 * it returns is the same protocol shape {@link sigstoreSigner} produces; a host
 * pins the leaf's own SPKI as the publisher root.
 */
export function ephemeralSigner(): ArtifactSigner {
  return {
    async sign(request) {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const { protocolSubject, bytes } = await releaseSubject(request.subject);
      const sig = sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' });
      const certDer = buildKeylessLeafCertificate({
        publicKey,
        signingKey: privateKey,
        issuer: request.subject.issuer,
        email: identityEmail(request.subject.subjectClaims),
      });
      const publisherSig: PublisherSignature = {
        alg: 'ES256',
        cert: Buffer.from(certDer).toString('base64'),
        issuer: request.subject.issuer,
        subjectClaims: request.subject.subjectClaims,
        sig: sig.toString('base64'),
      };
      return buildEnvelope(protocolSubject, publisherSig);
    },
  };
}
