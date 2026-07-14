/**
 * The **vanilla** template (SPEC §3, GW-D22): the bundler-free reference. A
 * single hand-written ES module registers the custom element and speaks the
 * widget ABI (core §4) directly against the DOM — no framework, no build step.
 *
 * It consumes the real `@gridmason/sdk` **shared-core** helpers (`recordSource`,
 * `settingsSource`) — the framework-agnostic reactive seams a vanilla widget is
 * documented to bind to directly (the dedicated `@gridmason/sdk/vanilla`
 * ergonomic wrappers land with SDK issue #10). Before a host wires the
 * capability-scoped handle to `.sdk`, the element falls back to `createNoopSDK`
 * so the scaffold renders on first run (SPEC §3) — the same dev handle the
 * dashboard's static boot uses.
 */
import { ACTION_EVENT, READY_EVENT, abiRuntimeSource, firstContextSlot, observedAttributesLiteral } from './abi.js';
import type { GeneratedFile, TemplateContext } from './index.js';

/** Emit the vanilla template's files: a single self-contained `entry`. */
export function vanillaFiles(ctx: TemplateContext): GeneratedFile[] {
  const { manifest, className } = ctx;
  const tag = manifest.tag;
  const slot = firstContextSlot(manifest);
  const contents = `// ${manifest.name} — vanilla Gridmason widget (bundler-free reference).
//
// A plain ES module: no framework, no build step. It registers the custom
// element below and implements the widget ABI (core §4) directly — the four
// host attributes in, CustomEvents out. Data flows through the capability-scoped
// SDK handle the host assigns to \`.sdk\`; this reference binds the real
// @gridmason/sdk shared-core reactive sources over that handle.
import { recordSource, settingsSource } from '@gridmason/sdk';
import { createNoopSDK } from '@gridmason/sdk/noop';

${abiRuntimeSource()}

// The context slot this widget reads its primary record from (manifest
// \`requiresContext\`). Its value is a RecordRef the SDK reads through.
const CONTEXT_SLOT = '${slot}';

class ${className}Element extends HTMLElement {
  static get observedAttributes() {
    return ${observedAttributesLiteral()};
  }

  constructor() {
    super();
    this._sdk = null;
    this._records = null;
    this._settings = null;
    this._unsubscribe = [];
  }

  // Host -> widget: the capability-scoped SDK handle. All privileged I/O goes
  // through it; the shared-core helpers are ergonomics over this handle.
  set sdk(handle) {
    this._sdk = handle;
    this._bind();
  }

  get sdk() {
    return this._sdk ?? this._ensureSdk();
  }

  connectedCallback() {
    this._bind();
    // Widget -> host: announce the mount so the host can wire the handle.
    emit(this, '${READY_EVENT}', { tag: '${tag}', instanceId: readHostState(this).instanceId });
  }

  disconnectedCallback() {
    this._teardown();
  }

  attributeChangedCallback() {
    this._render();
  }

  // Fall back to the dev no-op handle until the host wires a real one, so the
  // widget renders on first run (SPEC §3). The author's host replaces this.
  _ensureSdk() {
    if (this._sdk) return this._sdk;
    const state = readHostState(this);
    const opts = {};
    if (state.instanceId !== undefined) opts.instanceId = state.instanceId;
    if (state.context !== undefined) opts.context = state.context;
    if (state.settings !== undefined) opts.settings = state.settings;
    this._sdk = createNoopSDK(opts);
    return this._sdk;
  }

  _teardown() {
    for (const off of this._unsubscribe) off();
    this._unsubscribe = [];
  }

  // (Re)bind the reactive sources to the current handle and render on change.
  _bind() {
    if (!this.isConnected) return;
    this._teardown();
    const sdk = this._ensureSdk();
    this._records = recordSource(sdk, sdk.context[CONTEXT_SLOT]);
    this._settings = settingsSource(sdk);
    this._unsubscribe.push(this._records.subscribe(() => this._render()));
    this._unsubscribe.push(this._settings.subscribe(() => this._render()));
    this._render();
  }

  _render() {
    if (!this.isConnected) return;
    const record = this._records ? this._records.getSnapshot() : { status: 'idle', data: undefined };
    const settings = this._settings ? this._settings.getSnapshot() : {};
    this.replaceChildren();

    const root = document.createElement('section');
    root.className = 'gm-widget';

    const title = document.createElement('h1');
    title.textContent = settings.title ? String(settings.title) : '${manifest.name}';
    root.appendChild(title);

    const status = document.createElement('p');
    status.textContent = 'Primary record (' + CONTEXT_SLOT + '): ' + record.status + '.';
    root.appendChild(status);

    // Widget -> host: a sample outbound DOM action event (distinct from the
    // capability-gated SDK event bus; declare an \`events:\` capability to use that).
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Send action';
    button.addEventListener('click', () => emit(this, '${ACTION_EVENT}', { source: '${tag}' }));
    root.appendChild(button);

    this.appendChild(root);
  }
}

if (!customElements.get('${tag}')) {
  customElements.define('${tag}', ${className}Element);
}
`;
  return [{ path: 'src/entry.js', contents }];
}
