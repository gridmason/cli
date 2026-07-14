---
"@gridmason/cli": patch
---

Fill the three `init` templates with real ABI skeletons: **vanilla**
(bundler-free reference, GW-D22), **React**, and **Vue**. Each emits a plain
ES-module `entry` that registers the widget's custom element and speaks the
widget ABI (core §4) — the `context`/`settings`/`instance-id`/`edit-mode`
attributes in, bubbling `CustomEvent`s (`gridmason:ready`, `gridmason:action`)
out, and the capability-scoped host SDK handle read from `.sdk`. React and Vue
author their component as plain ESM (no JSX/SFC) so the baseline entry loads with
no build step, importing `react`/`react-dom`/`vue` by the same bare specifiers
they declare in `sharedScope`; vanilla is a self-contained module graph. A
headless-DOM harness (`test/templates.test.ts`) loads each `entry` as a plain ES
module and asserts it registers its tag, mounts, and emits `gridmason:ready`.
Template contract documented in `docs/templates.md`.
