/**
 * Keyless artifact signing (SPEC §7, §8): `publish` binds a short-lived signature
 * to the OIDC identity `login` established and produces a **DSSE-shaped signature
 * envelope** (`payloadType` + `payload` + non-empty `signatures[]`) over the
 * canonicalized artifact subject. The registry Publish API validates that shape
 * structurally and stores it opaquely; cryptographic verification against the
 * `@gridmason/protocol` envelope types is the registry's countersign stage
 * (registry docs/api/publish.md, "Signature envelope").
 *
 * The CLI holds **no bespoke crypto** and, keyless by default, no long-lived key:
 *
 * - {@link sigstoreSigner} is the production path — `@sigstore/sign`'s
 *   {@link DSSEBundleBuilder} mints an ephemeral keypair in memory, gets a Fulcio
 *   short-lived certificate bound to the OIDC token, and logs to Rekor. Nothing
 *   touches disk. It needs network + an allowlisted-issuer token, so it is
 *   exercised opt-in (like `login`'s live-staging leg), not in the offline suite.
 * - {@link ephemeralSigner} is an offline keyless signer for the dev/e2e loop: a
 *   per-invocation in-memory ECDSA P-256 key signs the payload (ES256) and is
 *   discarded — no certificate, no network, no persisted key. It yields the same
 *   DSSE shape the Publish API accepts, so the whole publish flow is drivable
 *   against a local registry without reaching Sigstore.
 *
 * The signer is injected into `publish` (see `src/publish/run.ts`) so a test can
 * drive the flow deterministically; the command wires {@link sigstoreSigner}.
 */
import { createSign, generateKeyPairSync, createHash } from 'node:crypto';
import { DSSEBundleBuilder, FulcioSigner, RekorWitness, type IdentityProvider } from '@sigstore/sign';
import { canonicalize } from '@gridmason/protocol';
import type { SigstoreInstance } from './identity.js';

/** The DSSE payload media type for a Gridmason artifact submission (matches the registry). */
export const ARTIFACT_PAYLOAD_TYPE = 'application/vnd.gridmason.artifact+json';

/**
 * A DSSE-shaped signature envelope — exactly the structural shape the registry
 * Publish API requires. `payload` is base64 of the signed bytes; each entry of
 * `signatures` carries a base64 `sig` and an optional `keyid`.
 */
export interface DsseEnvelope {
  readonly payloadType: string;
  readonly payload: string;
  readonly signatures: readonly { readonly sig: string; readonly keyid?: string }[];
}

/** What the publisher commits to: the version-qualified artifact and its content-hash map. */
export interface ArtifactSubject {
  /** Version-qualified artifact id, `<tag>@<version>`. */
  readonly artifact: string;
  /** `{ served path → content hash }` — the exact immutable bytes the signature covers. */
  readonly contentHashes: Readonly<Record<string, string>>;
  /** OIDC issuer the publisher authenticated to (provenance mirrored into the payload). */
  readonly issuer: string;
  /** Identity claims the OIDC issuer asserted (provenance; the cert is the trust anchor). */
  readonly subjectClaims: Readonly<Record<string, string>>;
}

/** One signing request: the subject to sign and the OIDC token to bind it to. */
export interface SignRequest {
  readonly subject: ArtifactSubject;
  /** The OIDC token (keyless binding); the same token authorizes the upload. */
  readonly token: string;
}

/** Signs an artifact subject into a DSSE envelope. Injected into `publish` for testability. */
export interface ArtifactSigner {
  sign(request: SignRequest): Promise<DsseEnvelope>;
}

/** The canonical bytes signed for a subject (RFC-8785 via `@gridmason/protocol`). */
function subjectBytes(subject: ArtifactSubject): Uint8Array {
  return canonicalize(subject);
}

/**
 * The production keyless signer: a Sigstore DSSE bundle over the subject, with a
 * Fulcio short-lived cert bound to the OIDC identity and a Rekor inclusion entry.
 * The ephemeral signing key is minted in memory by {@link FulcioSigner} and never
 * persisted. Returns the bundle's DSSE envelope in the structural shape the
 * Publish API validates.
 */
export function sigstoreSigner(instance: SigstoreInstance, provider: IdentityProvider): ArtifactSigner {
  return {
    async sign(request) {
      const builder = new DSSEBundleBuilder({
        signer: new FulcioSigner({ fulcioBaseURL: instance.fulcioURL, identityProvider: provider }),
        witnesses: [new RekorWitness({ rekorBaseURL: instance.rekorURL })],
      });
      const bundle = await builder.create({ data: Buffer.from(subjectBytes(request.subject)), type: ARTIFACT_PAYLOAD_TYPE });
      const content = bundle.content;
      if (content?.$case !== 'dsseEnvelope') {
        throw new Error('sigstore signer did not produce a DSSE envelope');
      }
      const env = content.dsseEnvelope;
      return {
        payloadType: env.payloadType,
        payload: Buffer.from(env.payload).toString('base64'),
        signatures: env.signatures.map((s) => ({
          sig: Buffer.from(s.sig).toString('base64'),
          ...(s.keyid ? { keyid: s.keyid } : {}),
        })),
      };
    },
  };
}

/**
 * An offline keyless signer for the dev/e2e loop (no Sigstore, no network): a
 * fresh in-memory ECDSA P-256 keypair signs the canonical subject (ES256,
 * IEEE-P1363), then is discarded — no certificate, no persisted key. The DSSE
 * envelope it returns is structurally what the Publish API accepts; it is not a
 * Fulcio-backed keyless credential (that is {@link sigstoreSigner}).
 */
export function ephemeralSigner(): ArtifactSigner {
  return {
    sign(request) {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const data = Buffer.from(subjectBytes(request.subject));
      const sig = createSign('SHA256').update(data).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
      const keyid = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
      return Promise.resolve({
        payloadType: ARTIFACT_PAYLOAD_TYPE,
        payload: data.toString('base64'),
        signatures: [{ sig: sig.toString('base64'), keyid }],
      });
    },
  };
}
