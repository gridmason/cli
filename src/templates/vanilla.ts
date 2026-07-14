/**
 * The **vanilla** template (SPEC §3, GW-D22): the bundler-free reference. A
 * single hand-written ES module registers the custom element and speaks the
 * widget ABI (core §4) directly against the DOM — no framework, no build step.
 *
 * It consumes the real `@gridmason/sdk/vanilla` reference adapter — the non-hook
 * helpers a framework-free widget imports: `watchRecord` (subscribe to the primary
 * context record's read state) and `bindSettings` (an imperative settings binding).
 * Each bottoms out in a handle method, so the widget stays auditable by reading its
 * SDK calls. Before a host wires the capability-scoped handle to `.sdk`, the element
 * falls back to `createNoopSDK` so the scaffold renders on first run (SPEC §3) — the
 * same dev handle the dashboard's static boot uses.
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
// @gridmason/sdk/vanilla helpers (watchRecord, bindSettings) over that handle.
import { bindSettings, watchRecord } from '@gridmason/sdk/vanilla';
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
    this._settings = null;
    // Latest record-read snapshot; watchRecord pushes it (idle -> pending -> success/error).
    this._record = { status: 'idle', data: undefined };
    this._unsubscribe = [];
  }

  // Host -> widget: the capability-scoped SDK handle. All privileged I/O goes
  // through it; the @gridmason/sdk/vanilla helpers are ergonomics over this handle.
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

  // (Re)bind the vanilla helpers to the current handle and render on change.
  // watchRecord and bindSettings().watch each fire immediately with the current
  // value and again on every change, returning an Unsubscribe we retain.
  _bind() {
    if (!this.isConnected) return;
    this._teardown();
    const sdk = this._ensureSdk();
    this._settings = bindSettings(sdk);
    this._unsubscribe.push(
      watchRecord(sdk, sdk.context[CONTEXT_SLOT], (snapshot) => {
        this._record = snapshot;
        this._render();
      }),
    );
    this._unsubscribe.push(this._settings.watch(() => this._render()));
  }

  _render() {
    if (!this.isConnected) return;
    const record = this._record;
    const settings = this._settings ? this._settings.get() : {};
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
