# Seeded `fixtures/`

`gridmason widget init` seeds a `fixtures/` directory so the very first `gridmason
dev` renders with data — before the author writes a line of widget code (SPEC §3,
FR-3). The dev server mounts the widget on the SDK **fixture implementation**
(`createFixtureSDK`, sdk §5): record reads/queries, scoped network calls, and
cross-widget events are answered from these files instead of a live backend, and
named context presets let one widget be exercised against several page contexts —
**no backend is ever required in the dev loop** (SPEC §4).

The fixture-file **shape is owned by `@gridmason/sdk`** (`@gridmason/sdk/fixture`,
sdk FR-4): a seeded file is a `FixtureFile` and `gridmason dev` consumes it
verbatim. The CLI never re-declares the shape — it imports the types and emits
values of them.

## Layout

```
fixtures/
  default.json               # the FixtureFile gridmason dev mounts by default
  contexts/
    <record>-2.json          # a named page-context preset (gridmason dev --context <record>-2)
```

- **`default.json`** is a complete `FixtureFile`: `records` (reads + queries),
  `net` (scoped-request stubs), `events` (scripted emissions), and `context` (the
  default page-context preset the widget mounts against with no `--context` flag).
- **`contexts/<name>.json`** is a standalone `PageContext` — a *named preset*.
  `gridmason dev --context <name>` (#9) loads it and passes it as the mounted
  widget's `sdk.context`, overriding `default.json`'s inline `context` while the
  `records`/`net`/`events` still come from `default.json`. One example preset is
  seeded per scaffold (named after the primary record's alternate sample, e.g.
  `example-2`, mirroring SPEC §4's `--context customer-42`); add your own by
  dropping more `PageContext` files here.

## What gets seeded, from what in the manifest

The layout is derived **mechanically from the manifest** — change the manifest's
declared context or capabilities and re-run `init`, and the seeded files change to
match:

| Manifest declaration | Seeds |
|---|---|
| a `requiresContext` slot with a `recordType` | a `records.read` **template** (a ref pattern with no `id`, so it serves any id of that type) and a one-row `records.query` list for that type, plus a `record-ref` value for that slot in every context preset |
| a `requiresContext` slot **without** a `recordType` | a string placeholder (`sample-<slot>`) for that slot in every context preset (the manifest carries no finer type) |
| a `net:<host>` capability | one empty `net` stub keyed by `host` + `path` (`/`), responding `200` with a `{}` body — a placeholder to fill in |
| an `events:<ns>` capability | one scripted `events` emission on that namespace (topic `<ns>`/`sample`, fired at `delay: 0`) |

Distinct record types and net hosts are de-duplicated; declaration order is
preserved.

### Capability enforcement — fixture-green predicts review-green

`createFixtureSDK` enforces the widget's declared capabilities exactly as a real
host would (`min(user, widget)`, SPEC §5/§6): a call for a capability the manifest
did **not** declare is denied with a typed `PermissionDenied`, and a fixture never
satisfies it. So a seeded record only renders when the manifest also declares the
covering capability — for records that is `records.read:recordType:<type>` (the
SDK's records scope grammar, SPEC §3.1, `records.read:recordType:customer`), not a
bare `records.read:<type>`. `widget init` pairs each sample `requiresContext`
recordType with the matching capability, so the default scaffold renders green;
if you add a `requiresContext` type without its `records.read:recordType:<type>`
capability, the dev inspector flags that call as `denied` rather than
`fixture-hit` — the same verdict registry review would give.

## Editing

Everything under `fixtures/` is plain JSON and hot-reloads in `gridmason dev` like
source. Reshape a record's `fields`, add query results, fill in `net` response
bodies, script more `events`, or add named context presets under `contexts/`. The
authoritative field-by-field schema and its matching semantics (subset match,
most-specific-wins) live with the shape's owner, `@gridmason/sdk` — see that
package's `docs/fixture-schema.md`.
