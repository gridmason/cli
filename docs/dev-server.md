# `gridmason dev` — the local author loop

`gridmason dev` is the develop step of the author loop (SPEC §4, FR-4/FR-5). It
starts a localhost HTTP server that does four jobs and **no more** — it is a
conduit, never a data backend:

1. **Serves the widget `entry` module** (and its sibling source) so the Gridmason
   Dashboard's `dev` mode can hot-load it through its per-session allowlist (the
   dashboard owns that dev CSP gate — SPEC §4).
2. **Runs a standalone fixture harness** at `/` that mounts the widget on the SDK
   fixture implementation, so the loop works with no dashboard and no backend.
3. **Live-reloads** on every edit to `src/`, `manifest.json`, or `fixtures/`, and
   **re-validates the manifest** on the fly.
4. **Mounts an SDK inspector** (`/@dev/inspector`) showing the capabilities the
   manifest declared against the SDK calls the widget actually made — so an
   undeclared reach or an uncovered data path is visible before review. See
   [The SDK inspector](#the-sdk-inspector-spec-4-fr-6).

```
gridmason dev                       # fixture harness at http://127.0.0.1:3000
gridmason dev --context example-2   # mount the fixtures/contexts/example-2.json preset
gridmason dev --proxy http://localhost:5173   # forward SDK calls to a real host
gridmason dev --port 4000 --json
```

## No backend, ever

Every datum the widget sees comes from a **fixture file** or the **`--proxy`
target** — never from the dev server itself. In fixture mode the server serves
the project's `fixtures/default.json` and the browser answers SDK calls locally
through `createFixtureSDK` (`@gridmason/sdk/fixture`); the server has no dataset
of its own and answers no SDK calls (a `POST /@dev/sdk` in fixture mode is a
`409`). The manifest, capabilities, fixtures, and context are all **read fresh
from disk on every request** (`Cache-Control: no-store`), so the server never
holds stale state — an edit is visible the moment a consumer re-asks.

## The routes

All dev-only routes are namespaced under `/@dev/` so they cannot collide with a
widget source path. Every response carries `Access-Control-Allow-Origin: *` so
the dashboard, on its own origin, can import the entry and fetch the dev state.

| Route | Serves |
|---|---|
| `GET /` | the standalone fixture harness host page |
| `GET /<entry>` (e.g. `/src/entry.js`) | the widget source, straight from the project tree |
| `GET /@dev/manifest` | `{ valid, violations, tag, entry }` — the live validation verdict |
| `GET /@dev/capabilities` | the manifest's declared `capabilities` |
| `GET /@dev/fixtures` | the base `FixtureFile` (`records`/`net`/`events`) |
| `GET /@dev/context` | `{ context, source, name? }` — the active page context |
| `GET /@dev/events` | the SSE stream (hot-reload `reload` frames **and** SDK-inspector `inspect` frames) |
| `GET /@dev/inspector` | the standalone SDK-inspector page |
| `GET /@dev/inspect` | `{ declared, calls }` — the current inspector session (catch-up for a freshly-opened panel) |
| `POST /@dev/inspect` | the harness reports one observed gated SDK call `{ method, outcome, arg }` |
| `POST /@dev/sdk` | **proxy mode only:** enforce + forward one SDK call |
| `GET /@npm/@gridmason/…` | the browser-side `@gridmason/*` ESM for the harness import map |

## The SDK inspector (SPEC §4, FR-6)

`gridmason dev` mounts a standalone **SDK inspector** at `GET /@dev/inspector`
(also linked from the harness dev bar). It answers one review-anticipating
question for the author: **do the capabilities the manifest declared match the
SDK calls the widget actually makes?** It changes no runtime behavior and serves
no data — it is a pure feedback lens over the calls the mount already makes.

The page has two tables:

- **Declared capabilities** — every capability the live manifest declares, each
  marked `used` or `not yet used` this session. A `not yet used` capability is an
  over-declaration to trim before publishing (a smaller capability set clears
  review faster).
- **Observed SDK calls** — every **gated** call the widget made, one row each:

  | Column | Meaning |
  |---|---|
  | `#` | arrival order within the current mount (resets each re-mount) |
  | `Method` | the dotted SDK method, e.g. `records.read` |
  | `Capability` | the capability the call required, in `<api>[:<scope>]` form |
  | `Declared` | `declared`, or **`undeclared`** — a **violation**: the manifest never declared this capability, so a host (and review) would deny it. The row is flagged red. |
  | `Outcome` | how the call resolved (below) |

  Outcomes: **`fixture-hit`** (a fixture answered), **`default-empty`** (allowed
  but no fixture matched — an uncovered data path, flagged amber, add a fixture),
  **`allowed`** (a gated `events` call, no fixture concept), **`denied`** (the
  undeclared-capability violation). Under `--proxy`, the server records each
  forwarded call as **`proxied`** (or **`proxy-error`**) instead, since data comes
  from the real host rather than a fixture.

Only capability-bearing (gated `records` / `net` / `events`) calls appear —
ungated calls (`settings` / `nav` / `telemetry`) carry no capability and are out
of scope for a capability inspector.

**How it stays live.** In fixture mode the SDK fixture implementation
(`@gridmason/sdk/fixture`) already tags each gated call on its shared recorder
with the outcome above; the harness reports that tag to `POST /@dev/inspect`,
where the server enriches it with the required capability and whether the live
manifest declares it (the same grammar the `--proxy` gate uses), then broadcasts
it to the inspector as an `inspect` frame over the **shared SSE channel** — no
second transport. A freshly-opened panel catches up via `GET /@dev/inspect`.
Every re-mount (a source/manifest reload, or a fixture/context hot-swap) starts a
fresh session: the server clears the log and the inspector re-pulls, so the panel
always reflects the current code, never a stale accumulation across edits.

## `--context <name>` — named page-context presets

By default the harness mounts against `fixtures/default.json`'s inline `context`.
`--context <name>` instead loads `fixtures/contexts/<name>.json` (a `PageContext`)
and passes it as the widget's `sdk.context`, **overriding** the default context
while `records` / `net` / `events` still come from `default.json` (the #8 layout
contract, `docs/fixtures.md`). A named preset that does not exist is a hard error
— a typo should not silently fall back to the default.

## Hot-reload mechanism (the spec's open question, resolved)

The spec's Risks section left the plain-ESM hot-reload mechanism open — glob vs.
cache-busting import URLs. `dev` uses **cache-busting import URLs plus a scoped
reload**, because two browser facts rule out a naive re-`import`:

- A module URL, once imported, is cached for the life of the document.
- A custom-element **tag can be defined only once** per document — re-importing a
  fresh copy of the entry re-runs `customElements.define`, which is a no-op the
  second time, so the *old* class stays registered.

So the server serves `Cache-Control: no-store` and, over the SSE stream, a
`reload` event tagged with the change **category** and a monotonically increasing
**generation** token. The harness reacts by category:

| Change | Category | Reaction |
|---|---|---|
| a `src/` file | `source` | **full page reload** — the server re-renders the harness with a bumped generation, so the entry is imported at a fresh `?v=<generation>` URL in a fresh document: new module graph, new element class, no stale cache |
| `manifest.json` | `manifest` | full page reload (and the CLI re-validates; violations print to stderr) |
| `fixtures/default.json` | `fixtures` | **hot data swap** — re-fetch fixtures, tear the element down, re-mount on a new fixture SDK; the module is never re-imported |
| `fixtures/contexts/**` | `context` | hot data swap with the new context |

The generation only bumps for `source`/`manifest` (the categories that need a
fresh module graph); a data-only change reuses it. This is the whole mechanism:
cache-busting URLs defeat the module cache, and a full-document reload defeats the
one-shot `customElements.define`, while fixture/context edits skip both for an
instant data refresh.

> The built-in harness targets the plain-ESM (vanilla) entry, which imports
> nothing but its own module graph. A React or Vue entry imports its framework by
> bare specifier from the host's shared scope, so it is exercised through the
> dashboard's `dev` sideload (which supplies that scope), not the standalone
> harness.

## `--proxy <host-url>` — real host, capabilities still enforced

`--proxy` trades fixtures for integration realism: the widget's SDK calls are
forwarded to a **real running host**, with the capability check **still
enforced**. This is the load-bearing rule — a capability the manifest does not
declare stays **denied through the proxy**, exactly as the fixture SDK or a
conforming host would deny it (`min(user, widget)`, SPEC §5/§6). A denied call
**never reaches the target**: enforcement is a gate in front of the transport,
not a filter after it.

The capability grammar has one definition (`@gridmason/protocol` §3.1); the dev
server parses declared capabilities with `parseCapability` and applies the
scope-prefix grant rule (an `<api>[:<scope>]` grants a required capability iff the
api matches and the declared scope path is a prefix of the required one).

### The dev-proxy wire contract

The dev server forwards each allowed, gated SDK call to the target as:

```
POST <host-url>/__gridmason_dev__/sdk
Content-Type: application/json

{ "method": "records.read", "args": [ { "recordType": "customer", "id": "c1" } ] }
```

and expects `{ "ok": true, "value": <result> }` (or `{ "ok": false, "error": "…" }`).
The `POST /@dev/sdk` endpoint answers the browser proxy client with one of:

- `{ "status": "forwarded", "value": … }` — granted and relayed from the target,
- `{ "status": "denied", "capability": { … } }` — the required capability is not declared,
- `{ "status": "error", "message": … }` — the target was unreachable or errored.

This forward format is pinned by **`@gridmason/protocol@0.0.4`**, which owns the
contract — `DEV_PROXY_SDK_PATH` plus the `DevProxySdkRequest` / `DevProxySdkResponse`
types (and their `isDevProxySdkRequest` / `isDevProxySdkResponse` guards). `dev`
consumes those exports rather than re-declaring the shape, so its forward leg and
a host's receive endpoint (a `gridmason/dashboard` deliverable) meet on one
definition. No shipped host implements the receive side yet; this is the shape a
host must match to be a `--proxy` target.
