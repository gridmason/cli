/**
 * The widget ABI (core §4) shared by every template. A scaffolded `entry` is a
 * plain ES module that registers a custom element speaking this contract:
 *
 * - **Host → widget** (in): the `context`, `settings`, `instance-id`, and
 *   `edit-mode` attributes. `context`/`settings` carry JSON; `instance-id` is an
 *   opaque string; `edit-mode` is a boolean (present, and not `"false"`).
 * - **Host → widget** (handle): the capability-scoped `HostSDK` handle, assigned
 *   by the host to the element's `sdk` property. All privileged I/O flows through
 *   it; the `@gridmason/sdk` framework helpers are thin ergonomics over this
 *   handle (they are the author's to import once the adapters ship — see
 *   `docs/templates.md`).
 * - **Widget → host** (out): bubbling, composed `CustomEvent`s the host shell
 *   catches — a `gridmason:ready` on mount and any author-defined actions.
 *
 * Every template embeds {@link abiRuntimeSource} verbatim so the four attributes
 * are read and events are emitted identically regardless of framework. This
 * module is the single source of the attribute and event names.
 */

/** The four ABI attributes a host sets on a mounted widget element (core §4). */
export const OBSERVED_ATTRIBUTES = ['context', 'settings', 'instance-id', 'edit-mode'] as const;

/** Widget → host: dispatched once the element has mounted. */
export const READY_EVENT = 'gridmason:ready';

/** Widget → host: a sample author-defined outbound action event. */
export const ACTION_EVENT = 'gridmason:action';

/** The `observedAttributes` array literal, single-sourced from {@link OBSERVED_ATTRIBUTES}. */
export function observedAttributesLiteral(): string {
  return `[${OBSERVED_ATTRIBUTES.map((a) => `'${a}'`).join(', ')}]`;
}

/**
 * The framework-agnostic ABI runtime, embedded verbatim into every generated
 * `entry`. Pure ES — no imports, no template literals — so it drops into any
 * template body and loads in a bare import-map harness with no build step.
 *
 * Exposes two helpers to the surrounding element class:
 * - `readHostState(el)` → `{ context, settings, instanceId, editMode }` parsed
 *   from the four ABI attributes.
 * - `emit(el, type, detail)` → dispatch a bubbling, composed `CustomEvent`.
 */
export function abiRuntimeSource(): string {
  return `// --- Gridmason widget ABI (core §4) — host <-> widget contract ---

/** Parse a JSON-bearing attribute; undefined when absent or malformed. */
function parseJsonAttr(value) {
  if (value === null || value === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Read the four ABI attributes off the element into a plain host-state object. */
function readHostState(el) {
  return {
    context: parseJsonAttr(el.getAttribute('context')),
    settings: parseJsonAttr(el.getAttribute('settings')),
    instanceId: el.getAttribute('instance-id') ?? undefined,
    editMode: el.hasAttribute('edit-mode') && el.getAttribute('edit-mode') !== 'false',
  };
}

/** Widget -> host: dispatch a bubbling, composed CustomEvent the host shell catches. */
function emit(el, type, detail) {
  el.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
}`;
}
