/**
 * The manifest-stub generator (SPEC §3, FR-2): pure functions from resolved
 * `init` answers to a `@gridmason/protocol` {@link Manifest}. The tag is
 * publisher-prefixed and the **publisher-prefix lint rule is enforced here, at
 * creation** — via the protocol's own `lintTag`, never a re-declared rule — so a
 * scaffold can never emit a manifest that would fail review.
 */
import { type Manifest, type ManifestKind, lintTag } from '@gridmason/protocol';
import { getTemplate, type Framework } from '../templates/index.js';

/** The resolved answers `init` scaffolds from (prompted or passed as flags). */
export interface InitAnswers {
  /** Human-readable widget name (also the source of the slug and tag suffix). */
  name: string;
  /** Publisher namespace prefix; the tag must start with `<publisher>-`. */
  publisher: string;
  /** Artifact kind (mirrors the `widget` noun namespace). */
  kind: ManifestKind;
  /** Starter framework; sets the manifest `sharedScope` defaults. */
  framework: Framework;
}

/** A scaffold that cannot proceed, carrying a stable code for machine output. */
export class InitError extends Error {
  constructor(
    readonly code: InitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InitError';
  }
}

/** Enumerated `init` failures — callers switch on the code, not the message. */
export type InitErrorCode =
  /** A required answer (name or publisher) was absent in non-interactive mode. */
  | 'missing-answer'
  /** The name slugified to the empty string (no usable tag suffix). */
  | 'invalid-name'
  /** The derived tag failed `lintTag` (e.g. an invalid publisher prefix). */
  | 'invalid-tag'
  /** A `--kind` / `--framework` flag was not one of the allowed values. */
  | 'invalid-option'
  /** The target directory already exists and is not empty. */
  | 'dir-not-empty';

/**
 * Slugify a name into a custom-element-safe suffix: lowercase, non-alphanumerics
 * collapsed to single hyphens, trimmed. May be empty (caller rejects that).
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** PascalCase class name derived from a slug (`sales-chart` → `SalesChart`). */
export function toClassName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Build the manifest stub for the given answers. Throws {@link InitError} when
 * the name has no slug or the derived tag fails the protocol tag lint (which
 * includes the publisher-prefix rule) — a scaffold never emits an unlintable
 * manifest.
 */
export function buildManifestStub(answers: InitAnswers): Manifest {
  const slug = slugify(answers.name);
  if (slug.length === 0) {
    throw new InitError('invalid-name', `"${answers.name}" has no usable letters or digits for a tag`);
  }

  const template = getTemplate(answers.framework);
  const tag = `${answers.publisher}-${slug}`;

  const tagLint = lintTag(tag, answers.publisher);
  if (!tagLint.ok) {
    const reasons = tagLint.violations.map((v) => v.message).join('; ');
    throw new InitError('invalid-tag', `generated tag "${tag}" is invalid: ${reasons}`);
  }

  // The sample context slot + matching capability make the scaffold immediately
  // coherent and give the fixture-seeding step (#8) a recordType to seed from.
  const manifest: Manifest = {
    formatVersion: '1.0',
    tag,
    kind: answers.kind,
    name: answers.name,
    publisher: answers.publisher,
    version: '0.1.0',
    entry: template.entryPath,
    props: 'props.schema.json',
    thumbnail: 'thumbnail.svg',
    size: { default: [4, 3] },
    requiresContext: { primary: { recordType: 'example' } },
    capabilities: [{ api: 'records.read', scope: 'example' }],
    ...(template.sharedScope ? { sharedScope: template.sharedScope } : {}),
  };

  return manifest;
}
