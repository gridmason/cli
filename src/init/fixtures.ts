/**
 * The `fixtures/` seeding seam (FR-3, SPEC §3): `init` calls {@link seedFixtures}
 * and writes whatever it returns, so a scaffold's first `gridmason dev` renders
 * with data before the author edits anything (SPEC §4).
 *
 * The layout is derived **mechanically from the manifest** — changing the
 * manifest's declared context or capabilities changes what gets seeded:
 *
 * - each `requiresContext` slot with a `recordType` → a `records.read` template
 *   and a `records.query` list for that type, plus a slot in the default context
 *   preset (a `record-ref` value the widget mounts against);
 * - each `net:<host>` capability → an empty `net` stub keyed by host + path;
 * - each `events:<ns>` capability → a scripted emission on that namespace;
 * - a `contexts/<record>-N.json` named preset per record-ref primary, so one
 *   widget can be exercised against several page contexts (`gridmason dev
 *   --context <name>`, #9).
 *
 * The fixture-file **shape is owned by `@gridmason/sdk`** (sdk FR-4, SPEC §5):
 * this module consumes {@link FixtureFile} and its members from
 * `@gridmason/sdk/fixture` and never re-declares them — a seeded file is a
 * compile-checked `FixtureFile`, and `gridmason dev` (#9) mounts it verbatim
 * through `createFixtureSDK`. Because that handle enforces `min(user, widget)`
 * capabilities, a seeded record only renders when the manifest actually declares
 * the covering `records.read:recordType:<type>` capability — fixture-green
 * predicts review-green (SPEC §5).
 */
import type { Capability, ContextValue, PageContext } from '@gridmason/protocol';
import type {
  FixtureFile,
  NetFixture,
  QueryFixture,
  ReadFixture,
  RecordFields,
  RecordFixtures,
  ScriptedEvent,
} from '@gridmason/sdk/fixture';
import type { GeneratedFile, TemplateContext } from '../templates/index.js';

/** One `requiresContext` slot reduced to what the seeder needs. */
interface ContextSlot {
  /** The slot key as declared in `requiresContext` (e.g. `primary`). */
  readonly key: string;
  /** The record type the slot carries, when it is a `record-ref` slot. */
  readonly recordType?: string;
}

/** Note stamped on every seeded sample so its provenance is obvious in the editor. */
const SEED_NOTE = 'Seeded by `gridmason init` — edit fixtures/ to shape your dev data (SPEC §5).';

/** Serialize a value as pretty JSON with a trailing newline (matches `files.ts`). */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Illustrative fields for a sample record of `recordType` (host owns the real vocabulary). */
function sampleFields(recordType: string): RecordFields {
  return { name: `Sample ${recordType}`, note: SEED_NOTE };
}

/** The `<recordType>-<n>` sample id used by presets and query results. */
function sampleId(recordType: string, n: number): string {
  return `${recordType}-${n}`;
}

/** The declared `requiresContext` slots, in declaration order. */
function contextSlots(manifestContext: TemplateContext['manifest']['requiresContext']): ContextSlot[] {
  const requires = manifestContext ?? {};
  return Object.entries(requires).map(([key, requirement]) =>
    requirement.recordType === undefined ? { key } : { key, recordType: requirement.recordType },
  );
}

/** The distinct record types across all `record-ref` slots, in first-seen order. */
function recordTypesOf(slots: readonly ContextSlot[]): string[] {
  const seen = new Set<string>();
  const types: string[] = [];
  for (const slot of slots) {
    if (slot.recordType !== undefined && !seen.has(slot.recordType)) {
      seen.add(slot.recordType);
      types.push(slot.recordType);
    }
  }
  return types;
}

/** The distinct scopes of the manifest capabilities whose `api` is `wanted`, in order. */
function scopesForApi(capabilities: readonly Capability[], wanted: Capability['api']): string[] {
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const capability of capabilities) {
    if (capability.api === wanted && capability.scope !== undefined && !seen.has(capability.scope)) {
      seen.add(capability.scope);
      scopes.push(capability.scope);
    }
  }
  return scopes;
}

/** The record side: a read template + a one-row query list per record type. */
function buildRecords(recordTypes: readonly string[]): RecordFixtures {
  const read: ReadFixture[] = recordTypes.map((recordType) => ({
    // A ref pattern with no `id` is a template: it serves any id of the type
    // (the returned record echoes the requested ref), so every preset resolves.
    ref: { recordType },
    fields: sampleFields(recordType),
  }));
  const query: QueryFixture[] = recordTypes.map((recordType) => ({
    match: { recordType },
    result: [{ ref: { recordType, id: sampleId(recordType, 1) }, fields: sampleFields(recordType) }],
  }));
  return { read, query };
}

/** An empty `{}`-body stub per declared `net:<host>` capability, keyed by host + path. */
function buildNet(hosts: readonly string[]): NetFixture[] {
  return hosts.map((host) => ({
    match: { host, path: '/' },
    response: { status: 200, body: {} },
  }));
}

/** A scripted sample emission per declared `events:<ns>` capability. */
function buildEvents(namespaces: readonly string[]): ScriptedEvent[] {
  return namespaces.map((ns) => ({
    topic: { ns, name: 'sample' },
    payload: { sample: true, note: SEED_NOTE },
    delay: 0,
  }));
}

/**
 * A page-context preset: every slot filled with a concrete value so the widget
 * mounts against real context. `record-ref` slots point at `<recordType>-<n>`;
 * any other slot gets a string placeholder (the manifest carries no finer type).
 */
function buildContext(slots: readonly ContextSlot[], n: number): PageContext {
  const context: Record<string, ContextValue> = {};
  for (const slot of slots) {
    context[slot.key] =
      slot.recordType === undefined
        ? `sample-${slot.key}`
        : { recordType: slot.recordType, id: sampleId(slot.recordType, n) };
  }
  return context;
}

/**
 * Generate the `fixtures/` files for a scaffold, derived from the manifest.
 * Emits `fixtures/default.json` (a complete {@link FixtureFile} `gridmason dev`
 * mounts by default) and, when there is a `record-ref` slot to vary, one
 * `fixtures/contexts/<record>-2.json` named preset to demonstrate `--context`.
 */
export function seedFixtures(ctx: TemplateContext): GeneratedFile[] {
  const { manifest } = ctx;
  const slots = contextSlots(manifest.requiresContext);
  const recordTypes = recordTypesOf(slots);
  const capabilities = manifest.capabilities ?? [];

  const fixture: FixtureFile = {
    records: buildRecords(recordTypes),
    net: buildNet(scopesForApi(capabilities, 'net')),
    events: buildEvents(scopesForApi(capabilities, 'events')),
    context: buildContext(slots, 1),
  };

  const files: GeneratedFile[] = [{ path: 'fixtures/default.json', contents: json(fixture) }];

  // A named preset only adds value when a record-ref slot exists to vary; name it
  // after the first record's alternate sample (mirrors SPEC §4's `--context customer-42`).
  const primaryRecordType = recordTypes[0];
  if (primaryRecordType !== undefined) {
    const presetName = sampleId(primaryRecordType, 2);
    files.push({
      path: `fixtures/contexts/${presetName}.json`,
      contents: json(buildContext(slots, 2)),
    });
  }

  return files;
}
