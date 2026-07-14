---
'@gridmason/cli': patch
---

Adopt `@gridmason/protocol@0.0.4`'s dev-proxy contract. The `--proxy` forward leg
now consumes `DEV_PROXY_SDK_PATH` and the `DevProxySdkRequest` / `DevProxySdkResponse`
types (with the `isDevProxySdkResponse` guard) from the protocol instead of
re-declaring the path constant and request/response shapes locally, so `dev` and a
host meet on one pinned wire contract. No behavior change: the capability gate still
runs before any forward and an undeclared capability stays denied without reaching
the target.
