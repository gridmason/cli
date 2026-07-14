# `init` templates — vanilla, React, Vue

`gridmason widget init` scaffolds a project from one of three starter templates
(SPEC §3, FR-2). Each emits a plain **ES-module `entry`** that registers the
widget's custom element and speaks the widget ABI (core §4) — the same contract
regardless of framework. This page is the template contract: what each one emits,
its build expectation, and the tag-registration guarantee the harness enforces.

## The widget ABI (shared by every template)

The `entry` registers a custom element whose tag is the manifest's
publisher-prefixed `tag`. Registration is idempotent (`if
(!customElements.get(tag))`), so importing the entry twice is safe.

**Host → widget (attributes in).** The host sets four attributes; the element
observes all four and re-renders on change:

| Attribute | Carries | Read as |
|---|---|---|
| `context` | The page context slots the host supplies | JSON |
| `settings` | The user-facing settings (validated against `props.schema.json`) | JSON |
| `instance-id` | Opaque id for this mount | string |
| `edit-mode` | Whether the dashboard is in edit mode | boolean (present and not `"false"`) |

**Host → widget (the SDK handle).** The host assigns the capability-scoped
`HostSDK` handle to the element's `sdk` property. All privileged I/O flows
through it. The `@gridmason/sdk` framework helpers (`useRecord`, `useSettings`,
`emit`, `scopedFetch`, …) are thin ergonomics over this handle — import them from
`@gridmason/sdk/{react,vue,vanilla}` when you add real data logic. The scaffold
wires the handle seam (`.sdk`) and renders from attributes until a host connects,
so the skeleton runs before those adapters are in place.

**Widget → host (events out).** The element dispatches bubbling, composed
`CustomEvent`s the host shell catches:

- `gridmason:ready` — dispatched once on mount, `detail: { tag, instanceId }`.
- `gridmason:action` — a sample author-defined outbound event (the vanilla
  template wires a button to it); replace or extend it with your own.

The ABI runtime (`readHostState`, `emit`) is embedded verbatim in every `entry`
so the four attributes are read and events emitted identically across frameworks.

## The three templates

| Template | Build expectation | `sharedScope` | Files |
|---|---|---|---|
| **vanilla** | **None.** A hand-written ES module; runs with no build step and an empty import map. The reference the others are measured against (GW-D22). | — (self-contained) | `src/entry.js` |
| **React** | None for the scaffolded baseline (plain `createElement`, no JSX). Adopt JSX + any ESM-emitting bundler when you want; the CLI is not a bundler. | `react ^18`, `react-dom ^18` | `src/entry.js`, `src/app.js` |
| **Vue** | None for the scaffolded baseline (a render function, no SFC). Add `.vue` files + a bundler when you want. Heritage from `vue3-widget-template`. | `vue ^3` | `src/entry.js`, `src/app.js` |

For React and Vue the `entry` imports its framework by bare specifier
(`react`, `react-dom/client`, `vue`); those are exactly the `sharedScope`
entries, so the host provides them through its import map rather than the widget
bundling its own copy. The vanilla entry imports nothing — its module graph is
self-contained, which is why it declares no `sharedScope`.

Each framework component receives host state (`context`, `settings`,
`instanceId`, `editMode`) plus the `sdk` handle. React re-renders through the
retained root on any attribute or handle change; Vue holds host state in a single
`reactive` object mutated in place (no remount per update).

## Tag-registration contract & harness

The acceptance guarantee (issue #7): **each template's `entry` loads in a bare
import-map harness — no bundler, no dashboard — and registers its
custom-element tag.** `test/templates.test.ts` proves it for all three: it writes
each template's files to a scratch dir, imports the `entry` as a plain ES module
under a headless DOM (`happy-dom`), and asserts the tag is defined, the element
mounts, and it emits `gridmason:ready`. The `react`/`react-dom`/`vue` specifiers
resolve from `node_modules`, standing in for the shared modules a host supplies
through its import map — no bundler is ever in the loop.
