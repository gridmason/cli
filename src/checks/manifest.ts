/**
 * Manifest lint — the first review check (SPEC §5.1, FR-7). It is three checks
 * that together answer "would the registry accept this manifest?":
 *
 * - `manifest.schema` — the manifest is valid against the **authoritative**
 *   `@gridmason/protocol` manifest JSON Schema (protocol §3.1). This covers the
 *   `size` / context / `capabilities` / `requires` *shapes*, the required
 *   fields, the `formatVersion` / `version` patterns, the `kind` enum, and
 *   `additionalProperties: false` — one validator, not a re-declared shape.
 * - `manifest.tag` — the `tag` is publisher-prefixed, lowercase, and hyphenated,
 *   via the protocol's `lintTag` (the publisher-prefix rule the JSON Schema
 *   cannot express).
 * - `manifest.capabilities` — each capability's scope grammar is well-formed,
 *   via the protocol's `validateCapability` (catches `net:` / `a::b`, which the
 *   schema's "scope is a string" cannot).
 *
 * Every rule is `@gridmason/protocol`'s own — the shapes are never re-declared
 * here, so `gridmason lint` and registry review cannot diverge (SPEC §8). The
 * schema is loaded from the shipped `@gridmason/protocol/schemas/manifest.json`
 * and compiled with `ajv`, the injected validator the protocol package documents
 * (its published bundle carries no validator of its own).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv, type ErrorObject } from 'ajv';
import {
  CAPABILITY_APIS,
  formatCapability,
  lintTag,
  validateCapability,
  type Capability,
  type CapabilityApi,
  type CapabilityError,
  type TagViolationCode,
} from '@gridmason/protocol';
import type { Check, CheckResult } from './types.js';

const require = createRequire(import.meta.url);

// Load + compile the authoritative manifest schema once, at module load. Read
// via `require.resolve` + `readFileSync` (the repo's established pattern for the
// shipped schema) so no `resolveJsonModule` / import-attribute machinery is
// needed. `strict: false` matches the protocol's documented injection recipe
// (the schema uses draft-07 tuple items ajv strict-mode would reject);
// `allErrors` reports every violation in one pass, not just the first.
const manifestSchema = JSON.parse(
  readFileSync(require.resolve('@gridmason/protocol/schemas/manifest.json'), 'utf8'),
) as object;
const validateManifestSchema = new Ajv({ strict: false, allErrors: true }).compile(manifestSchema);

/** A plain, non-null, non-array object (the only manifest shape worth inspecting). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Render one ajv error as a compact, location-prefixed line. */
function formatSchemaError(error: ErrorObject): string {
  const where = error.instancePath === '' ? 'manifest' : error.instancePath;
  if (error.keyword === 'additionalProperties') {
    const prop = (error.params as { additionalProperty?: string }).additionalProperty;
    return `${where}: unknown property "${prop}" (additionalProperties are not allowed)`;
  }
  return `${where}: ${error.message ?? 'is invalid'}`;
}

/**
 * `manifest.schema` — the manifest conforms to the protocol manifest JSON Schema.
 * The one gate that validates the untrusted manifest as a whole; the other checks
 * assume nothing it does not establish.
 */
export const manifestSchemaCheck: Check = {
  id: 'manifest.schema',
  title: 'manifest schema',
  rationale:
    'The manifest must be valid against the @gridmason/protocol manifest schema (protocol §3.1): ' +
    'required fields, the formatVersion/version patterns, the kind enum, the size/context/' +
    'capability/requires shapes, and no unknown properties. This is the authoritative shape check.',
  run(ctx): CheckResult[] {
    const ok = validateManifestSchema(ctx.manifest);
    if (ok) {
      return [{ id: this.id, status: 'pass', message: 'manifest is schema-valid' }];
    }
    const errors = validateManifestSchema.errors ?? [];
    const hint = 'align manifest.json with the manifest schema (protocol §3.1)';
    if (errors.length === 0) {
      return [{ id: this.id, status: 'fail', message: 'manifest does not conform to the manifest schema', hint }];
    }
    return errors.map((error) => ({ id: this.id, status: 'fail', message: formatSchemaError(error), hint }));
  },
};

/** A fix hint tailored to each tag-lint violation the protocol reports. */
function tagHint(code: TagViolationCode): string {
  switch (code) {
    case 'missing-publisher-prefix':
      return 'prefix the tag with "<publisher>-" so it matches the manifest publisher';
    case 'missing-hyphen':
      return 'a custom-element tag needs at least one hyphen (e.g. "acme-chart")';
    case 'not-lowercase':
      return 'use only lowercase letters in the tag';
    case 'invalid-characters':
      return 'use only [a-z0-9-], starting with a letter';
    case 'empty':
      return 'set a non-empty tag';
  }
}

/**
 * `manifest.tag` — the tag satisfies the protocol tag rules, **including the
 * publisher-prefix** (the rule the JSON Schema cannot express). Defers to
 * `manifest.schema` when `tag` is absent or not a string.
 */
export const manifestTagCheck: Check = {
  id: 'manifest.tag',
  title: 'manifest tag',
  rationale:
    'The tag is the widget custom-element name, so it must be lowercase, contain a hyphen, use ' +
    'only [a-z0-9-], and be prefixed with "<publisher>-". The publisher-prefix rule is enforced ' +
    'here via the protocol lintTag because a JSON Schema cannot relate the tag to the publisher.',
  run(ctx): CheckResult[] {
    const manifest = isObject(ctx.manifest) ? ctx.manifest : {};
    const tag = manifest.tag;
    // A missing / non-string tag is a schema failure; manifest.schema owns it.
    if (typeof tag !== 'string') {
      return [];
    }
    const publisher = typeof manifest.publisher === 'string' ? manifest.publisher : undefined;
    const result = lintTag(tag, publisher);
    if (result.ok) {
      return [{ id: this.id, status: 'pass', message: `tag "${tag}" is well-formed${publisher ? ' and publisher-prefixed' : ''}` }];
    }
    return result.violations.map((violation) => ({
      id: this.id,
      status: 'fail',
      message: `tag "${tag}": ${violation.message}`,
      hint: tagHint(violation.code),
    }));
  },
};

/** Human phrasing for the capability errors this check can surface. */
function capabilityErrorMessage(error: CapabilityError): string {
  switch (error) {
    case 'empty-scope-segment':
      return 'a scope segment is empty (e.g. "net:" or "a::b")';
    case 'unknown-api':
      return 'unknown capability api';
    case 'empty-api':
      return 'the api segment is empty';
    case 'empty':
      return 'the capability is empty';
  }
}

/**
 * `manifest.capabilities` — each declared capability's **scope grammar** is
 * well-formed, via the protocol's `validateCapability`. Focused on what the JSON
 * Schema misses (empty scope segments): the api enum and array shape are
 * `manifest.schema`'s job, so an element whose api is not a known {@link
 * CapabilityApi} is left for that check rather than double-reported here.
 */
export const manifestCapabilitiesCheck: Check = {
  id: 'manifest.capabilities',
  title: 'manifest capabilities',
  rationale:
    "Each capability's colon-delimited scope must be well-formed (no empty segment), checked with " +
    'the protocol validateCapability so lint and registry review agree. The api enum and the array ' +
    'shape are covered by manifest.schema; this check adds the scope-grammar the schema cannot express.',
  run(ctx): CheckResult[] {
    const manifest = isObject(ctx.manifest) ? ctx.manifest : {};
    const capabilities = manifest.capabilities;
    // A non-array (or absent) capabilities field is manifest.schema's concern.
    if (!Array.isArray(capabilities)) {
      return [];
    }
    const results: CheckResult[] = [];
    capabilities.forEach((capability, index) => {
      // Only well-shaped, known-api capabilities reach the grammar check; the
      // rest are manifest.schema's to report.
      if (!isObject(capability) || typeof capability.api !== 'string') {
        return;
      }
      if (!(CAPABILITY_APIS as readonly string[]).includes(capability.api)) {
        return;
      }
      const api = capability.api as CapabilityApi;
      const cap: Capability = typeof capability.scope === 'string' ? { api, scope: capability.scope } : { api };
      const error = validateCapability(cap);
      if (error !== undefined) {
        results.push({
          id: this.id,
          status: 'fail',
          message: `capabilities[${index}] (${formatCapability(cap)}): ${capabilityErrorMessage(error)}`,
          hint: 'give every colon-delimited scope segment a non-empty value',
        });
      }
    });
    if (results.length > 0) {
      return results;
    }
    return [
      {
        id: this.id,
        status: 'pass',
        message: capabilities.length > 0 ? 'all capabilities are well-formed' : 'no capabilities declared',
      },
    ];
  },
};

/** The manifest-lint checks (SPEC §5.1), in report order. */
export const manifestChecks: readonly Check[] = [manifestSchemaCheck, manifestTagCheck, manifestCapabilitiesCheck];

// Re-exported so a consumer that narrows a capability api has the protocol's
// source of truth without a second import.
export type { CapabilityApi };
