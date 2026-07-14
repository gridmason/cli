/**
 * The `dev` server's view of the widget project on disk (SPEC §4, FR-4/FR-5).
 * Everything the server hands a consumer — the manifest and its live validation,
 * the declared capabilities, the entry path, the fixture file, and the active
 * page context — is read **fresh from disk on every call**. The dev server is a
 * conduit, never a cache: an edit to `manifest.json`, `fixtures/`, or a source
 * file is reflected the next time a consumer asks (the file watcher only *nudges*
 * the browser to re-ask — see `watch.ts`). Reading fresh is what makes "manifest
 * edit → live re-validation" and "fixture edit → data updates" correct without
 * any invalidation bookkeeping.
 *
 * The manifest/capability/context vocabulary is owned by `@gridmason/protocol`
 * and the fixture-file shape by `@gridmason/sdk`; this module imports those types
 * and never re-declares them (the same discipline as `init`).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Capability, type Manifest, type PageContext, lintTag } from '@gridmason/protocol';
import { defaultValidateManifest } from '@gridmason/protocol/vectors';
import type { FixtureFile } from '@gridmason/sdk/fixture';

/** The manifest file a project is anchored on. */
export const MANIFEST_FILE = 'manifest.json';
/** The default `FixtureFile` mounted when no `--context` overrides the context. */
export const DEFAULT_FIXTURE_FILE = 'fixtures/default.json';
/** The directory named `--context <name>` presets are resolved under. */
export const CONTEXTS_DIR = 'fixtures/contexts';

/** A widget project rooted at the directory holding its `manifest.json`. */
export interface DevProject {
  /** Absolute path to the project root (the directory containing the manifest). */
  readonly root: string;
}

/**
 * The manifest as it currently sits on disk, with its live validation verdict.
 * `manifest` is the parsed value when JSON-parseable (even if it fails
 * validation, so the server can still surface the tag/entry it *claims*);
 * `null` only when the bytes are not JSON at all.
 */
export interface ManifestState {
  /** The raw file bytes, or `null` when `manifest.json` is missing. */
  readonly raw: string | null;
  /** The parsed manifest, or `null` when the bytes are absent or not JSON. */
  readonly manifest: Manifest | null;
  /** Whether the manifest passes the dev-time structural + tag checks. */
  readonly valid: boolean;
  /** Human-readable validation failures; empty when `valid`. */
  readonly violations: readonly string[];
}

/** Resolve a project rooted at `cwd` (the directory holding `manifest.json`). */
export function resolveProject(cwd: string): DevProject {
  return { root: path.resolve(cwd) };
}

/**
 * Read and validate `manifest.json`. Dev validation is deliberately the
 * lightweight, dependency-free pair the protocol package ships —
 * {@link defaultValidateManifest} (structural) + {@link lintTag} (the tag rules,
 * including the publisher prefix) — not the authoritative registry lint (that is
 * `gridmason lint`, epic L-E2). It is enough to catch the edits an author makes
 * mid-loop (a broken tag, a dropped required field, invalid JSON) and report them
 * live, which is the FR-4 requirement.
 */
export async function loadManifest(project: DevProject): Promise<ManifestState> {
  let raw: string;
  try {
    raw = await readFile(path.join(project.root, MANIFEST_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { raw: null, manifest: null, valid: false, violations: [`${MANIFEST_FILE} not found`] };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      raw,
      manifest: null,
      valid: false,
      violations: [`${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`],
    };
  }

  const violations: string[] = [];
  const structural = defaultValidateManifest(parsed);
  if (!structural) {
    violations.push(
      `${MANIFEST_FILE} failed structural validation (missing/invalid required fields; run \`gridmason lint\` for detail)`,
    );
  }

  // Only the parsed-object case exposes `tag`/`publisher`; a structurally invalid
  // manifest may still carry them, so lint the tag when both are strings.
  const manifest = parsed as Manifest;
  const record = parsed as Record<string, unknown>;
  if (typeof record.tag === 'string') {
    const publisher = typeof record.publisher === 'string' ? record.publisher : undefined;
    const tagLint = lintTag(record.tag, publisher);
    for (const v of tagLint.violations) {
      violations.push(`tag "${record.tag}": ${v.message}`);
    }
  }

  return { raw, manifest, valid: violations.length === 0, violations };
}

/** The declared capabilities of the current manifest (empty when absent/invalid). */
export function declaredCapabilities(state: ManifestState): readonly Capability[] {
  return state.manifest?.capabilities ?? [];
}

/**
 * Read `fixtures/default.json` — the base {@link FixtureFile} the widget mounts
 * against. A missing file is not an error: it yields the empty fixture (`{}`),
 * where every SDK call falls through to the SDK's typed-empty default. The dev
 * server holds **no data of its own** — this file (or the `--proxy` target) is
 * the only data source.
 */
export async function loadFixtures(project: DevProject): Promise<FixtureFile> {
  const parsed = await readJsonFile(path.join(project.root, DEFAULT_FIXTURE_FILE));
  return (parsed as FixtureFile | undefined) ?? {};
}

/** How the active page context was resolved. */
export type ContextSource = 'preset' | 'default' | 'none';

/** The page context a mount runs against, plus where it came from. */
export interface ActiveContext {
  /** The context value, or `undefined` when neither a preset nor a default exists. */
  readonly context: PageContext | undefined;
  /** Whether it came from a `--context` preset, `default.json`, or nowhere. */
  readonly source: ContextSource;
  /** The preset name, when `source` is `preset`. */
  readonly name?: string;
}

/**
 * Resolve the page context to mount against. With `contextName`, load
 * `fixtures/contexts/<name>.json` (a `PageContext`) and pass it as the widget's
 * `sdk.context`, overriding `default.json`'s inline `context` while records / net
 * / events still come from `default.json` (docs/fixtures.md, the #8 layout
 * contract). Without it, use `default.json`'s inline `context`.
 *
 * A named preset that does not exist is a hard error the caller surfaces — the
 * author asked for a specific context and typoing it should not silently fall
 * back to the default.
 */
export async function loadContext(project: DevProject, contextName?: string): Promise<ActiveContext> {
  if (contextName !== undefined) {
    const presetPath = path.join(project.root, CONTEXTS_DIR, `${contextName}.json`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(presetPath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DevProjectError(
          'context-not-found',
          `context preset "${contextName}" not found at ${path.join(CONTEXTS_DIR, `${contextName}.json`)}`,
        );
      }
      throw new DevProjectError('context-invalid', `context preset "${contextName}" is not valid JSON`);
    }
    return { context: parsed as PageContext, source: 'preset', name: contextName };
  }

  const fixtures = await loadFixtures(project);
  return fixtures.context !== undefined
    ? { context: fixtures.context, source: 'default' }
    : { context: undefined, source: 'none' };
}

/** A `dev` project failure with a stable, machine-switchable code. */
export class DevProjectError extends Error {
  constructor(
    readonly code: DevProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DevProjectError';
  }
}

/** Enumerated `dev` project failures — callers switch on the code, not the text. */
export type DevProjectErrorCode =
  /** No `manifest.json` at the project root — not a widget project. */
  | 'no-manifest'
  /** A `--context <name>` preset file does not exist. */
  | 'context-not-found'
  /** A `--context <name>` preset file is not valid JSON. */
  | 'context-invalid';

/** Read + parse a JSON file, returning `undefined` when it is absent. */
async function readJsonFile(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
  return JSON.parse(raw) as unknown;
}
