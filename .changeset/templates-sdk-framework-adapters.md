---
'@gridmason/cli': minor
---

Consume the published `@gridmason/sdk@0.3.0` framework adapters in the scaffold
templates. The Vue template now imports the `@gridmason/sdk/vue` composables
(`useRecord` / `useSettings`) and the vanilla template the `@gridmason/sdk/vanilla`
helpers (`watchRecord` / `bindSettings`), replacing the interim direct binding to
the `@gridmason/sdk` shared-core sources (`recordSource` / `settingsSource`); the
React template already consumed `@gridmason/sdk/react`. The host-provided `.sdk`
handle seam and the `createNoopSDK` first-run fallback are unchanged, as is the
plain-ESM entry + `sharedScope` contract. Scaffolded projects now pin
`@gridmason/sdk@^0.3.0`. Refs #25.
