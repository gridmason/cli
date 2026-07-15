/**
 * Keyless-certificate helpers for the publisher signature (SPEC §7; registry
 * `docs/api/publish.md`, "Signature envelope").
 *
 * The publisher half of the `@gridmason/protocol` `SignatureEnvelope` carries a
 * base64 DER X.509 **leaf certificate** whose public key verifies `publisherSig`
 * and whose Fulcio "OIDC Issuer" extension + subject-alternative-name are the
 * authorship anchor a host checks (`@gridmason/protocol` `verify/signature/der`).
 * Two producers need this shape:
 *
 * - the **Sigstore** signer receives a real Fulcio-issued leaf as PEM — we only
 *   extract its DER ({@link leafPemToDerBase64}) and convert Fulcio's DER ECDSA
 *   signature to the IEEE-P1363 form the protocol verifier consumes
 *   ({@link derEcdsaToP1363});
 * - the **offline/ephemeral** signer (dev + registry e2e) has no CA, so it mints a
 *   **self-issued** leaf in the exact narrow profile the protocol verifier parses
 *   ({@link buildKeylessLeafCertificate}) — a host pins that leaf's own SPKI as the
 *   publisher root.
 *
 * The accepted profile is deliberately narrow (the same one the protocol verifier
 * decodes and the registry's countersign fixtures build): a v3 layout whose
 * `tbsCertificate` children are `[0]version, serial, sigAlg, issuer, validity,
 * subject, spki, [3]extensions`, with the Fulcio issuer extension carrying a raw
 * UTF-8 string and a SAN carrying an rfc822 name. Node ships no builder for it, so
 * the DER is assembled by hand.
 */
import { sign, type KeyObject } from 'node:crypto';

/** DER: encode a definite length (short or long form). */
function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** DER: `tag || length || content`. */
function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), encodeLength(content.length), content);
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ecdsa-with-SHA256 = 1.2.840.10045.4.3.2
const OID_ECDSA_SHA256 = Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
// Sigstore/Fulcio "OIDC Issuer" = 1.3.6.1.4.1.57264.1.1
const OID_FULCIO_ISSUER = Uint8Array.of(0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xbf, 0x30, 0x01, 0x01);
// subjectAltName = 2.5.29.17
const OID_SAN = Uint8Array.of(0x55, 0x1d, 0x11);

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OID = 0x06;
const UTC_TIME = 0x17;
const CONTEXT_0 = 0xa0;
const CONTEXT_3 = 0xa3;
const SAN_RFC822 = 0x81;

function sigAlgSequence(): Uint8Array {
  return tlv(SEQUENCE, tlv(OID, OID_ECDSA_SHA256));
}

/** The Fulcio issuer extension: `SEQUENCE { OID, OCTET STRING(raw utf8 issuer) }`. */
function fulcioExtension(issuer: string): Uint8Array {
  return tlv(SEQUENCE, concat(tlv(OID, OID_FULCIO_ISSUER), tlv(OCTET_STRING, utf8(issuer))));
}

/** The SAN extension: `SEQUENCE { OID, OCTET STRING( SEQUENCE { [1] email } ) }`. */
function sanExtension(email: string): Uint8Array {
  const generalNames = tlv(SEQUENCE, tlv(SAN_RFC822, utf8(email)));
  return tlv(SEQUENCE, concat(tlv(OID, OID_SAN), tlv(OCTET_STRING, generalNames)));
}

/** Inputs for {@link buildKeylessLeafCertificate}. */
export interface KeylessLeafOptions {
  /** The subject public key whose SPKI the cert certifies. */
  readonly publicKey: KeyObject;
  /** The private key that self-signs the `tbsCertificate` (the same keypair). */
  readonly signingKey: KeyObject;
  /** OIDC issuer for the Fulcio issuer extension (the authorship trust anchor). */
  readonly issuer: string;
  /** SAN rfc822 (email) identity; omitted when the identity carries no email. */
  readonly email?: string | undefined;
}

/**
 * Build a **self-issued** DER X.509 leaf certificate in the narrow profile the
 * `@gridmason/protocol` verifier parses. The subject key signs its own
 * `tbsCertificate` (ECDSA P-256 / SHA-256), so the cert's issuing "root" is the
 * leaf key itself — a host pins that SPKI as the publisher root. Used only by the
 * offline/ephemeral signer; a Sigstore leaf comes from Fulcio.
 */
export function buildKeylessLeafCertificate(options: KeylessLeafOptions): Uint8Array {
  const spki = new Uint8Array(options.publicKey.export({ format: 'der', type: 'spki' }));

  const version = tlv(CONTEXT_0, tlv(INTEGER, Uint8Array.of(0x02))); // v3
  const serial = tlv(INTEGER, Uint8Array.of(0x01));
  const sigAlg = sigAlgSequence();
  const emptyName = tlv(SEQUENCE, new Uint8Array(0));
  // Validity is skipped by the protocol parser (the orchestrator owns the clock),
  // so a maximally-wide window keeps the leaf structurally valid without a clock.
  const validity = tlv(
    SEQUENCE,
    concat(tlv(UTC_TIME, utf8('700101000000Z')), tlv(UTC_TIME, utf8('491231235959Z'))),
  );

  const extensionList: Uint8Array[] = [fulcioExtension(options.issuer)];
  if (options.email !== undefined && options.email !== '') {
    extensionList.push(sanExtension(options.email));
  }
  const extensions = tlv(CONTEXT_3, tlv(SEQUENCE, concat(...extensionList)));

  const tbs = tlv(
    SEQUENCE,
    concat(version, serial, sigAlg, emptyName, validity, emptyName, spki, extensions),
  );

  // Self-sign the tbs bytes (ECDSA P-256 / SHA-256, DER encoding — X.509 cert
  // signatures are DER, distinct from the P1363 form the envelope signature uses).
  const signature = new Uint8Array(sign('sha256', tbs, { key: options.signingKey, dsaEncoding: 'der' }));
  const signatureValue = tlv(BIT_STRING, concat(Uint8Array.of(0x00), signature));

  return tlv(SEQUENCE, concat(tbs, sigAlg, signatureValue));
}

/**
 * Extract the leaf certificate's base64 DER from a PEM chain (Fulcio returns the
 * leaf first). Returns the standard-alphabet base64 the envelope's `cert` field
 * carries — the bytes between the first `-----BEGIN CERTIFICATE-----` block's
 * markers, whitespace stripped.
 */
export function leafPemToDerBase64(pem: string): string {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  if (match === null) {
    throw new Error('no PEM certificate found in the signer output');
  }
  return match[1]!.replace(/\s+/g, '');
}

/** Read a big-endian DER INTEGER's magnitude as a left-trimmed byte array. */
function readDerInteger(bytes: Uint8Array, offset: number): { value: Uint8Array; next: number } {
  if (bytes[offset] !== 0x02) throw new Error('malformed ECDSA signature: expected INTEGER');
  const len = bytes[offset + 1]!;
  // Long-form lengths never occur for P-256 r/s (≤ 33 bytes), so the short form suffices.
  if (len > 0x7f) throw new Error('malformed ECDSA signature: unexpected long-form length');
  let start = offset + 2;
  const end = start + len;
  // Drop a leading 0x00 sign byte.
  while (start < end - 1 && bytes[start] === 0x00) start += 1;
  return { value: bytes.slice(start, end), next: end };
}

/** Left-pad a coordinate to exactly 32 bytes (P-256). */
function pad32(value: Uint8Array): Uint8Array {
  if (value.length > 32) throw new Error('malformed ECDSA signature: coordinate too large for P-256');
  const out = new Uint8Array(32);
  out.set(value, 32 - value.length);
  return out;
}

/**
 * Convert a DER-encoded ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`) to
 * the IEEE-P1363 fixed-width `r || s` (64-byte, P-256) form the protocol verifier
 * consumes. Fulcio/`@sigstore/sign` emit DER; the envelope carries P1363.
 */
export function derEcdsaToP1363(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('malformed ECDSA signature: expected SEQUENCE');
  const seqLen = der[1]!;
  if (seqLen > 0x7f) throw new Error('malformed ECDSA signature: unexpected long-form length');
  const r = readDerInteger(der, 2);
  const s = readDerInteger(der, r.next);
  return concat(pad32(r.value), pad32(s.value));
}
