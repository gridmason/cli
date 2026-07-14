---
'@gridmason/cli': patch
---

Bump the `@gridmason/sdk` pin emitted by `widget init` (and the CLI's own dev dep) from `^0.3.0` to `^0.4.0` (#50).

In 0.x semver `^0.3.0` excludes 0.4.x, so scaffolded projects were pinned off the current sdk. The 0.4.0 changes (per-instance token contract, `events:<ns>` capability-gating enforcement, telemetry-attribution helpers, unmount hardening) are additive and host/transport-facing; the widget-author helper surfaces the templates consume (`useRecord`, `useSettings`, `watchRecord`, `bindSettings`, `createNoopSDK`) are unchanged, so template bodies and `docs/templates.md` need no changes. The template load-harness and scaffold→lint e2e stay green against the real 0.4.0 adapters.
