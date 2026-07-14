/**
 * Shared checks module tests (SPEC §5, §8; FR-7, FR-8).
 *
 * The manifest-lint checks are driven by `@gridmason/protocol`'s shipped
 * conformance vectors (protocol §6) — the shapes are never re-declared here, so a
 * divergence between these checks and the protocol contract fails a shared test
 * rather than production. The final block imports the module the way the registry
 * service does (only `../src/checks`, no CLI entrypoint) as the stand-in for that
 * outside consumer.
 */
import { describe, expect, it } from 'vitest';
import {
  capabilityObjectVectors,
  manifestVectors,
  runConformanceVectors,
  tagVectors,
} from '@gridmason/protocol/vectors';
import { FRAMEWORKS } from '../src/templates/index.js';
import { planScaffold } from '../src/init/files.js';
import {
  checks,
  hasFailure,
  manifestCapabilitiesCheck,
  manifestChecks,
  manifestSchemaCheck,
  manifestTagCheck,
  runChecks,
  type CheckContext,
} from '../src/checks/index.js';

/** A minimal well-formed manifest the capability-parity cases mutate. */
function baseManifest(): Record<string, unknown> {
  return {
    formatVersion: '1.0',
    tag: 'acme-sales-chart',
    kind: 'widget',
    name: 'Sales Chart',
    publisher: 'acme',
    version: '2.3.1',
    entry: 'widget.js',
  };
}

describe('manifest.schema check (driven by manifestVectors)', () => {
  it.each(manifestVectors)('$name → valid=$valid', (vector) => {
    const results = manifestSchemaCheck.run({ manifest: vector.manifest });
    expect(hasFailure(results)).toBe(!vector.valid);
    if (vector.valid) {
      expect(results).toEqual([{ id: 'manifest.schema', status: 'pass', message: 'manifest is schema-valid' }]);
    } else {
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.id === 'manifest.schema' && r.status === 'fail')).toBe(true);
    }
  });

  it('agrees with every shipped manifest vector via the protocol runner', () => {
    // Inject this module's schema validator into the protocol's own runner: it
    // must accept exactly the manifests the vectors declare valid.
    const report = runConformanceVectors({
      validateManifest: (manifest) => !hasFailure(manifestSchemaCheck.run({ manifest })),
    });
    expect(report.ok, report.failures).toBe(true);
  });
});

describe('manifest.tag check (driven by tagVectors)', () => {
  it.each(tagVectors)('$name → ok=$ok', (vector) => {
    const manifest: Record<string, unknown> = { tag: vector.tag };
    if (vector.publisher !== undefined) {
      manifest.publisher = vector.publisher;
    }
    const results = manifestTagCheck.run({ manifest });
    expect(hasFailure(results)).toBe(!vector.ok);
    if (vector.ok) {
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe('pass');
    } else {
      // One fail per violation the protocol reports.
      expect(results).toHaveLength(vector.codes.length);
      expect(results.every((r) => r.id === 'manifest.tag' && r.status === 'fail')).toBe(true);
    }
  });

  it('defers to the schema check when the tag is absent or not a string', () => {
    expect(manifestTagCheck.run({ manifest: {} })).toEqual([]);
    expect(manifestTagCheck.run({ manifest: { tag: 42 } })).toEqual([]);
    expect(manifestTagCheck.run({ manifest: null })).toEqual([]);
  });

  it('enforces the publisher prefix (the rule the JSON Schema cannot express)', () => {
    const results = manifestTagCheck.run({ manifest: { tag: 'other-widget', publisher: 'acme' } });
    expect(hasFailure(results)).toBe(true);
    expect(results.some((r) => /publisher/.test(r.message))).toBe(true);
  });
});

describe('manifest.capabilities check (driven by capabilityObjectVectors)', () => {
  // The check adds the scope-grammar the schema cannot express; the api enum is
  // the schema's job, so an `unknown-api` element is deferred, not failed here.
  it.each(capabilityObjectVectors)('$name', (vector) => {
    const results = manifestCapabilitiesCheck.run({ manifest: { capabilities: [vector.capability] } });
    const expectedFail = vector.error === 'empty-scope-segment';
    expect(hasFailure(results)).toBe(expectedFail);
  });

  it('reports the whole capability grammar across manifest.schema + manifest.capabilities', () => {
    // Every capabilityObjectVector error must fail *some* check when run through
    // the full manifest: unknown-api via manifest.schema, empty scope via
    // manifest.capabilities. This is the "one implementation, no divergence" bar.
    for (const vector of capabilityObjectVectors) {
      const manifest = { ...baseManifest(), capabilities: [vector.capability] };
      const results = runChecks({ manifest });
      expect(hasFailure(results), `${vector.name}: ${JSON.stringify(vector.capability)}`).toBe(
        vector.error !== undefined,
      );
    }
  });

  it('passes and defers correctly for absent / non-array capabilities', () => {
    expect(manifestCapabilitiesCheck.run({ manifest: {} })).toEqual([]);
    expect(manifestCapabilitiesCheck.run({ manifest: { capabilities: 'nope' } })).toEqual([]);
    const empty = manifestCapabilitiesCheck.run({ manifest: { capabilities: [] } });
    expect(empty).toHaveLength(1);
    expect(empty[0]?.status).toBe('pass');
  });
});

describe('check registry + runner', () => {
  it('registers exactly the manifest-lint checks in this phase', () => {
    expect(checks).toEqual(manifestChecks);
    expect(checks.map((c) => c.id)).toEqual(['manifest.schema', 'manifest.tag', 'manifest.capabilities']);
  });

  it('every check carries a stable id, title, and rationale (seeds the #14 reference)', () => {
    for (const check of checks) {
      expect(check.id).toMatch(/^[a-z]+\.[a-z-]+$/);
      expect(check.title.length).toBeGreaterThan(0);
      expect(check.rationale.length).toBeGreaterThan(0);
    }
  });

  it('runChecks flattens findings and hasFailure keys off fail only', () => {
    const clean = runChecks({ manifest: baseManifest() });
    expect(clean.every((r) => r.status === 'pass')).toBe(true);
    expect(hasFailure(clean)).toBe(false);

    const broken = runChecks({ manifest: { ...baseManifest(), tag: 'nohyphen' } });
    expect(hasFailure(broken)).toBe(true);
  });
});

describe('scaffold passes manifest lint out of the box (FR-2 / #6 acceptance)', () => {
  it.each(FRAMEWORKS)('a fresh %s scaffold lints clean', (framework) => {
    const { manifest } = planScaffold({ name: 'Sales Chart', publisher: 'acme', kind: 'widget', framework });
    const results = runChecks({ manifest });
    expect(hasFailure(results), JSON.stringify(results)).toBe(false);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });
});

describe('registry-consumer import (stand-in for the registry service, SPEC §8)', () => {
  // The registry imports `@gridmason/cli/checks` as a plain library. This block
  // imports only `../src/checks` — no `../src/cli`, no command, no IO sink — and
  // drives the pipeline, proving the module is usable without the CLI entrypoint.
  it('runs the shared checks with nothing but a CheckContext', () => {
    const ctx: CheckContext = {
      manifest: { ...baseManifest(), capabilities: [{ api: 'records.read', scope: 'recordType:customer' }] },
    };
    const results = runChecks(ctx);
    expect(results.map((r) => r.id)).toEqual(['manifest.schema', 'manifest.tag', 'manifest.capabilities']);
    expect(hasFailure(results)).toBe(false);
  });
});
