---
"@gridmason/cli": patch
---

Fill the three `init` templates with real ABI skeletons: **vanilla**
(bundler-free reference, GW-D22), **React**, and **Vue**. Each emits a plain
ES-module `entry` that registers the widget's custom element and speaks the
widget ABI (core §4) — the `context`/`settings`/`instance-id`/`edit-mode`
attributes in, bubbling `CustomEvent`s (`gridmason:ready`, `gridmason:action`)
out, and the capability-scoped host SDK handle read from `.sdk`.

Consumes the real `@gridmason/sdk@^0.2.0` helpers: React uses the reference
adapter `@gridmason/sdk/react` (`useRecord`, `useSettings`), while vanilla and Vue
bind the framework-agnostic shared-core sources (`recordSource`, `settingsSource`)
until the dedicated `@gridmason/sdk/{vanilla,vue}` adapters ship (SDK issue #10).
Before a host wires a handle, the element falls back to `createNoopSDK` so the
scaffold renders on first run. React and Vue author their component as plain ESM
(no JSX/SFC) so the baseline entry loads with no build step; vanilla imports no
framework runtime. A headless-DOM harness (`test/templates.test.ts`) loads each
`entry` as a plain ES module and asserts it registers its tag, mounts, emits
`gridmason:ready`, and drives a real SDK record read to resolution. Template
contract documented in `docs/templates.md`.
