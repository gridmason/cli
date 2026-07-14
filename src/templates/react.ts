/**
 * The **React** template (SPEC §3). A custom element hosts a React root; the
 * component is authored as plain ESM (`createElement`, no JSX) so the emitted
 * `entry` loads in a bare import-map harness with **no build step** — the author
 * opts into JSX and a bundler when they want (the CLI is not a bundler, GW-D22;
 * any ESM-emitting bundler produces this same plain-ESM entry). `react` and
 * `react-dom` are declared in the manifest `sharedScope`, so the host satisfies
 * them from its import map rather than the widget bundling its own copy.
 */
import { READY_EVENT, abiRuntimeSource, observedAttributesLiteral } from './abi.js';
import type { GeneratedFile, TemplateContext } from './index.js';

/** Emit the React template's files: the ABI element `entry` plus the component. */
export function reactFiles(ctx: TemplateContext): GeneratedFile[] {
  const { manifest, className } = ctx;
  const tag = manifest.tag;

  const app = `import { createElement as h } from 'react';

// The widget's React component. Plain ESM (no JSX) so the entry loads with no
// build step; adopt JSX + your bundler when you want richer authoring. Data
// access wraps the host-provided \`sdk\` handle with the @gridmason/sdk React
// helpers, e.g.:  import { useRecord, useSettings, emit } from '@gridmason/sdk/react';
export function App({ context, settings, instanceId, editMode, sdk }) {
  return h(
    'section',
    { className: 'gm-widget' },
    h('h1', null, '${manifest.name}'),
    h(
      'p',
      null,
      sdk ? 'Connected to the host SDK.' : 'No host SDK yet — rendering from attributes.',
    ),
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
    return this._sdk;
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

  _render() {
    if (!this._root) return;
    const state = readHostState(this);
    this._root.render(createElement(App, { ...state, sdk: this._sdk }));
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
