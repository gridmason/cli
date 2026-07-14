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
`HostSDK` handle (`@gridmason/sdk`) to the element's `sdk` property. All
privileged I/O flows through it. Each template consumes the **real** SDK helpers
over that handle:

- **React** uses the reference adapter `@gridmason/sdk/react`: `useRecord` (reads
  the primary context record) and `useSettings`. Every hook bottoms out in a
  handle method, so a widget stays auditable by reading its SDK calls.
- **Vue** uses the `@gridmason/sdk/vue` composables: `useRecord` and `useSettings`,
  which return reactive refs the render function unwraps with `.value`. The
  component receives the `sdk` handle as a prop and calls them in `setup()`.
- **vanilla** uses the `@gridmason/sdk/vanilla` helpers: `watchRecord` (subscribe
  to the primary record's read state) and `bindSettings` (an imperative settings
  binding), each returning an `Unsubscribe` the element retains and calls on teardown.

Each adapter mirrors the same surface in its framework's idiom, and every helper
bottoms out in a handle method — so a widget stays auditable by reading its SDK calls.

Before a host wires a real handle, the element falls back to `createNoopSDK`
(`@gridmason/sdk/noop`) seeded from the attributes — the same dev handle the
dashboard's static boot uses — so the scaffold **renders on first run** (SPEC §3).
`gridmason dev` supplies a fixture handle (`createFixtureSDK`) instead; the
author's host supplies the enforcing one. The author trims the fallback for
production.

**Widget → host (events out).** The element dispatches bubbling, composed
`CustomEvent`s the host shell catches:

- `gridmason:ready` — dispatched once on mount, `detail: { tag, instanceId }`.
- `gridmason:action` — a sample author-defined outbound event (the vanilla
  template wires a button to it); replace or extend it with your own.

These DOM CustomEvents are the mount-level ABI channel and are **not** the
capability-gated SDK event bus (`sdk.events.emit`, which needs an `events:<ns>`
capability the scaffold does not declare). The ABI runtime (`readHostState`,
`emit`) is embedded verbatim in every `entry` so the four attributes are read and
DOM events emitted identically across frameworks.

## The three templates

| Template | Build expectation | `sharedScope` | Files |
|---|---|---|---|
| **vanilla** | **None.** A hand-written ES module; runs with no build step. The reference the others are measured against (GW-D22). | — (no framework runtime) | `src/entry.js` |
| **React** | None for the scaffolded baseline (plain `createElement`, no JSX). Adopt JSX + any ESM-emitting bundler when you want; the CLI is not a bundler. | `react ^18`, `react-dom ^18` | `src/entry.js`, `src/app.js` |
| **Vue** | None for the scaffolded baseline (a render function, no SFC). Add `.vue` files + a bundler when you want. Heritage from `vue3-widget-template`. | `vue ^3` | `src/entry.js`, `src/app.js` |

For React and Vue the `entry` imports its framework runtime by bare specifier
(`react`, `react-dom/client`, `vue`); those are exactly the `sharedScope`
entries, so the host provides them through its import map rather than the widget
bundling its own copy. `@gridmason/sdk` (and its `/react`, `/vue`, `/vanilla`,
`/noop` subpaths) is **not** in `sharedScope` — it is the platform SDK the host
provides ambiently, the same convention the React runtime imports already follow.
The vanilla entry imports no framework runtime, which is why it declares no
`sharedScope`; it does import `@gridmason/sdk/vanilla` for its helpers.

The React component receives the `sdk` handle and calls the reference hooks; the
element re-renders through the retained React root on any attribute or handle
change. The Vue component likewise receives the `sdk` handle as a prop and calls
the `@gridmason/sdk/vue` composables in `setup()`, re-rendering reactively as their
refs advance (the element recreates the app on a handle rebind, since Vue `setup`
runs once). The vanilla element subscribes with `watchRecord` and
`bindSettings().watch` and re-renders on every change — no remount per update.

## Tag-registration contract & harness

The acceptance guarantee (issue #7): **each template's `entry` loads in a bare
import-map harness — no bundler, no dashboard — and registers its
custom-element tag.** `test/templates.test.ts` proves it for all three: it writes
each template's files to a scratch dir, imports the `entry` as a plain ES module
under a headless DOM (`happy-dom`), and asserts the tag is defined, the element
mounts, it emits `gridmason:ready`, and its real `@gridmason/sdk` record read
resolves through the `createNoopSDK` fallback. The bare specifiers the entries
import (`react`/`react-dom`/`vue` and `@gridmason/sdk` + subpaths) resolve from
`node_modules`, standing in for the modules a host supplies through its import
map — no bundler is ever in the loop.
