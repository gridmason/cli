/**
 * The **React** template (SPEC §3). A custom element hosts a React root; the
 * component is authored as plain ESM (`createElement`, no JSX) so the emitted
 * `entry` loads in a bare import-map harness with **no build step** — the author
 * opts into JSX and a bundler when they want (the CLI is not a bundler, GW-D22;
 * any ESM-emitting bundler produces this same plain-ESM entry). `react` and
 * `react-dom` are declared in the manifest `sharedScope`, so the host satisfies
 * them from its import map rather than the widget bundling its own copy.
 *
 * The component consumes the real `@gridmason/sdk/react` reference adapter —
 * `useRecord` (the primary context record) and `useSettings` — over the
 * capability-scoped handle. The element wires the host handle from `.sdk`,
 * falling back to `createNoopSDK` so the scaffold renders on first run (SPEC §3).
 */
import { READY_EVENT, abiRuntimeSource, firstContextSlot, observedAttributesLiteral } from './abi.js';
import type { GeneratedFile, TemplateContext } from './index.js';

/** Emit the React template's files: the ABI element `entry` plus the component. */
export function reactFiles(ctx: TemplateContext): GeneratedFile[] {
  const { manifest, className } = ctx;
  const tag = manifest.tag;
  const slot = firstContextSlot(manifest);

  const app = `import { createElement as h } from 'react';
import { useRecord, useSettings } from '@gridmason/sdk/react';

// The widget's React component. Plain ESM (no JSX) so the entry loads with no
// build step; adopt JSX + your bundler when you want richer authoring. Data
// access uses the @gridmason/sdk React reference hooks over the host handle —
// every hook bottoms out in an SDK method, so the widget stays auditable.
export function App({ sdk }) {
  // The primary context record (manifest \`requiresContext.${slot}\`); the hook is
  // called unconditionally and returns an idle result when the slot is absent.
  const { data, loading, error, status } = useRecord(sdk, sdk.context['${slot}']);
  const [settings] = useSettings(sdk);

  const title = settings.title ? String(settings.title) : '${manifest.name}';
  let detail;
  if (loading) detail = 'Loading the primary record…';
  else if (error) detail = 'Could not read the primary record.';
  else detail = 'Primary record (${slot}): ' + status + '.';

  return h(
    'section',
    { className: 'gm-widget' },
    h('h1', null, title),
    h('p', null, detail),
  );
}
`;

  const entry = `// ${manifest.name} — React Gridmason widget.
//
// A plain ES module registering the custom element below. It hosts a React root
// and implements the widget ABI (core §4): the four host attributes in,
// CustomEvents out, the capability-scoped SDK handle read from \`.sdk\`.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createNoopSDK } from '@gridmason/sdk/noop';
import { App } from './app.js';

${abiRuntimeSource()}

class ${className}Element extends HTMLElement {
  static get observedAttributes() {
    return ${observedAttributesLiteral()};
  }

  constructor() {
    super();
    this._sdk = null;
    this._root = null;
    this._mount = null;
  }

  set sdk(handle) {
    this._sdk = handle;
    this._render();
  }

  get sdk() {
    return this._sdk ?? this._ensureSdk();
  }

  connectedCallback() {
    this._mount = document.createElement('div');
    this.appendChild(this._mount);
    this._root = createRoot(this._mount);
    this._render();
    emit(this, '${READY_EVENT}', { tag: '${tag}', instanceId: readHostState(this).instanceId });
  }

  disconnectedCallback() {
    if (this._root) {
      this._root.unmount();
      this._root = null;
    }
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

  _render() {
    if (!this._root) return;
    this._root.render(createElement(App, { sdk: this._ensureSdk() }));
  }
}

if (!customElements.get('${tag}')) {
  customElements.define('${tag}', ${className}Element);
}
`;

  return [
    { path: 'src/app.js', contents: app },
    { path: 'src/entry.js', contents: entry },
  ];
}
