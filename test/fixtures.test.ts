import type { Capability, Manifest, PageContext } from '@gridmason/protocol';
import {
  createFixtureSDK,
  createManualScheduler,
  getFixtureControls,
  type FixtureFile,
} from '@gridmason/sdk/fixture';
import { describe, expect, it } from 'vitest';
import { seedFixtures } from '../src/init/fixtures.js';
import { buildManifestStub } from '../src/init/manifest.js';
import type { GeneratedFile, TemplateContext } from '../src/templates/index.js';

/** A minimal, valid manifest for a seeding test — only the fields the seeder reads matter. */
function mkManifest(partial: Partial<Manifest>): Manifest {
  return {
    formatVersion: '1.0',
    tag: 'acme-widget',
    kind: 'widget',
    name: 'Widget',
    publisher: 'acme',
    version: '0.1.0',
    entry: 'src/entry.js',
    ...partial,
  };
}

/** Wrap a manifest in the `TemplateContext` `seedFixtures` consumes. */
function ctxFor(manifest: Manifest): TemplateContext {
  return { manifest, framework: 'vanilla', slug: 'widget', className: 'Widget' };
}

/** Parse a seeded file's JSON, failing the test if it was not emitted. */
function parseFile<T>(files: readonly GeneratedFile[], path: string): T {
  const file = files.find((f) => f.path === path);
  expect(file, `expected seeded file ${path}`).toBeDefined();
  return JSON.parse(file!.contents) as T;
}

/** The default fixture file (`fixtures/default.json`) seeded for a manifest. */
function seedDefault(manifest: Manifest): FixtureFile {
  return parseFile<FixtureFile>(seedFixtures(ctxFor(manifest)), 'fixtures/default.json');
}

describe('seedFixtures — default scaffold manifest', () => {
  // The manifest `widget init` (#6) actually emits: one record-ref slot `primary`
  // of type `example` + the covering `records.read:recordType:example` capability.
  const manifest = buildManifestStub({ name: 'Sales Chart', publisher: 'acme', kind: 'widget', framework: 'vanilla' });

  it('mounts through the fixture SDK and renders sample data with the manifest\'s own capabilities', async () => {
    const fixture = seedDefault(manifest);

    // Mount exactly as `gridmason dev` (#9) will: the manifest's literal capabilities,
    // the file's own `context` preset (no override). This is the acceptance bar —
    // seeded files alone are sufficient, zero author edits.
    const sdk = createFixtureSDK(fixture, { capabilities: manifest.capabilities as Capability[] });

    // The widget mounts against a concrete page context from the file.
    expect(sdk.context['primary']).toEqual({ recordType: 'example', id: 'example-1' });

    const record = await sdk.records.read({ recordType: 'example', id: 'example-1' });
    expect(record.fields['name']).toBe('Sample example');
    expect(getFixtureControls(sdk).recorder.last('records.read')?.meta).toMatchObject({ outcome: 'fixture-hit' });

    const list = await sdk.records.query({ recordType: 'example' });
    expect(list).toHaveLength(1);
    expect(list[0]?.ref).toEqual({ recordType: 'example', id: 'example-1' });
    expect(getFixtureControls(sdk).recorder.last('records.query')?.meta).toMatchObject({ outcome: 'fixture-hit' });
  });

  it('seeds a named context preset whose id the read template also serves', async () => {
    const files = seedFixtures(ctxFor(manifest));
    const fixture = parseFile<FixtureFile>(files, 'fixtures/default.json');
    const altContext = parseFile<PageContext>(files, 'fixtures/contexts/example-2.json');
    expect(altContext['primary']).toEqual({ recordType: 'example', id: 'example-2' });

    // `gridmason dev --context example-2` overrides the file context with the preset;
    // the read fixture is a template (no id), so the alternate record resolves too.
    const sdk = createFixtureSDK(fixture, {
      capabilities: manifest.capabilities as Capability[],
      context: altContext,
    });
    expect(sdk.context['primary']).toEqual({ recordType: 'example', id: 'example-2' });
    const record = await sdk.records.read({ recordType: 'example', id: 'example-2' });
    expect(record.ref).toEqual({ recordType: 'example', id: 'example-2' });
    expect(getFixtureControls(sdk).recorder.last('records.read')?.meta).toMatchObject({ outcome: 'fixture-hit' });
  });

  it('denies a read the manifest did not declare (fixture never widens capability)', async () => {
    const fixture = seedDefault(manifest);
    // Mount with NO capabilities: enforcement holds even though a fixture exists.
    const sdk = createFixtureSDK(fixture, { capabilities: [] });
    await expect(sdk.records.read({ recordType: 'example', id: 'example-1' })).rejects.toThrow();
  });
});

describe('seedFixtures — derived mechanically from the manifest', () => {
  const mixed = mkManifest({
    requiresContext: {
      primary: { recordType: 'customer' },
      roster: { recordType: 'team' },
      title: {}, // a non-record-ref slot: gets a string placeholder
    },
    capabilities: [
      { api: 'records.read', scope: 'recordType:customer' },
      { api: 'records.read', scope: 'recordType:team' },
      { api: 'net', scope: 'api.acme.com' },
      { api: 'events', scope: 'acme.sales' },
    ],
  });

  it('seeds a record per record-ref slot, a net stub per host, and an events emission per namespace', async () => {
    const files = seedFixtures(ctxFor(mixed));
    const fixture = parseFile<FixtureFile>(files, 'fixtures/default.json');

    // One read template + one query list per distinct record type.
    expect(fixture.records?.read?.map((r) => r.ref.recordType)).toEqual(['customer', 'team']);
    expect(fixture.records?.query?.map((q) => q.match.recordType)).toEqual(['customer', 'team']);

    // One empty stub per net host, keyed by host + path.
    expect(fixture.net).toEqual([{ match: { host: 'api.acme.com', path: '/' }, response: { status: 200, body: {} } }]);

    // The default context covers every slot: record-refs get a value, others a placeholder.
    expect(fixture.context).toEqual({
      primary: { recordType: 'customer', id: 'customer-1' },
      roster: { recordType: 'team', id: 'team-1' },
      title: 'sample-title',
    });

    // Named preset is keyed off the first record-ref slot.
    parseFile<PageContext>(files, 'fixtures/contexts/customer-2.json');

    // The whole file mounts and serves data/net through the fixture SDK.
    const sdk = createFixtureSDK(fixture, { capabilities: mixed.capabilities as Capability[] });
    expect((await sdk.records.read({ recordType: 'team', id: 'team-9' })).fields['name']).toBe('Sample team');
    const res = await sdk.net.fetch({ host: 'api.acme.com', path: '/' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({});
    expect(getFixtureControls(sdk).recorder.last('net.fetch')?.meta).toMatchObject({ outcome: 'fixture-hit' });
  });

  it('delivers the seeded scripted event to a subscriber', () => {
    const fixture = seedDefault(mixed);
    expect(fixture.events).toEqual([
      { topic: { ns: 'acme.sales', name: 'sample' }, payload: { sample: true, note: expect.any(String) }, delay: 0 },
    ]);

    const scheduler = createManualScheduler();
    const sdk = createFixtureSDK(fixture, { capabilities: mixed.capabilities as Capability[], scheduler });
    const received: unknown[] = [];
    sdk.events.on({ ns: 'acme.sales', name: 'sample' }, (payload) => received.push(payload));
    scheduler.flush();
    expect(received).toEqual([{ sample: true, note: expect.any(String) }]);
  });

  it('changing the manifest changes what is seeded', () => {
    // No context, no capabilities → empty slots and no named preset file.
    const bare = seedFixtures(ctxFor(mkManifest({})));
    expect(bare.map((f) => f.path)).toEqual(['fixtures/default.json']);
    const bareFixture = parseFile<FixtureFile>(bare, 'fixtures/default.json');
    expect(bareFixture.records).toEqual({ read: [], query: [] });
    expect(bareFixture.net).toEqual([]);
    expect(bareFixture.events).toEqual([]);
    expect(bareFixture.context).toEqual({});

    // Adding a net capability adds exactly a net stub — nothing else.
    const withNet = seedDefault(mkManifest({ capabilities: [{ api: 'net', scope: 'api.example.com' }] }));
    expect(withNet.net).toHaveLength(1);
    expect(withNet.records).toEqual({ read: [], query: [] });
  });

  it('dedupes repeated record types and net hosts', () => {
    const dupes = seedDefault(
      mkManifest({
        requiresContext: { a: { recordType: 'customer' }, b: { recordType: 'customer' } },
        capabilities: [
          { api: 'net', scope: 'api.acme.com' },
          { api: 'net', scope: 'api.acme.com' },
        ],
      }),
    );
    expect(dupes.records?.read).toHaveLength(1);
    expect(dupes.net).toHaveLength(1);
    // Both slots still appear in the context preset (keyed by slot, not type).
    expect(Object.keys(dupes.context ?? {})).toEqual(['a', 'b']);
  });
});
