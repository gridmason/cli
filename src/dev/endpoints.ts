/**
 * The `dev` server's route table, in one place so the server (which answers
 * them) and the harness page (which calls them) can never drift. All dev-only
 * routes are namespaced under `/@dev/` so they cannot collide with a widget
 * source path served from the project tree.
 */
export const ENDPOINTS = {
  /** The standalone fixture harness host page. */
  harness: '/',
  /** GET the current manifest + its live validation verdict. */
  manifest: '/@dev/manifest',
  /** GET the widget's declared capabilities. */
  capabilities: '/@dev/capabilities',
  /** GET the base `FixtureFile` (records / net / events). */
  fixtures: '/@dev/fixtures',
  /** GET the active page context (a `--context` preset or `default.json`'s). */
  context: '/@dev/context',
  /** The Server-Sent-Events hot-reload stream (also carries `inspect` frames). */
  events: '/@dev/events',
  /** The standalone SDK-inspector page (declared capabilities vs observed calls). */
  inspector: '/@dev/inspector',
  /**
   * The SDK-inspector data channel: GET the current session (declared capabilities
   * + observed calls) for catch-up; POST one observed call for the harness to
   * report a gated SDK call it saw the widget make.
   */
  inspect: '/@dev/inspect',
  /** POST a proxied SDK call (only mounted in `--proxy` mode). */
  sdk: '/@dev/sdk',
  /** Prefix under which the browser-side `@gridmason/*` ESM is served. */
  npm: '/@npm/',
} as const;
