/**
 * The **Vue** template (SPEC §3; heritage from `vue3-widget-template`). A custom
 * element hosts a Vue app; the component is authored as a plain-ESM render
 * function (`h`, no single-file component) so the emitted `entry` loads in a bare
 * import-map harness with **no build step** — the author adds `.vue` SFCs and a
 * bundler when they want (the CLI is not a bundler, GW-D22). `vue` is declared in
 * the manifest `sharedScope`, so the host satisfies it from its import map.
 *
 * It consumes the real `@gridmason/sdk/vue` composables — `useRecord` (the primary
 * context record) and `useSettings` — over the capability-scoped handle. The
 * component receives the `sdk` handle as a prop and calls the composables in
 * `setup()`; every composable bottoms out in an SDK method, so the widget stays
 * auditable. The element wires the host handle from `.sdk`, falling back to
 * `createNoopSDK` so the scaffold renders on first run (SPEC §3).
 */
import { READY_EVENT, abiRuntimeSource, firstContextSlot, observedAttributesLiteral } from './abi.js';
import type { GeneratedFile, TemplateContext } from './index.js';

/** Emit the Vue template's files: the ABI element `entry` plus the component. */
export function vueFiles(ctx: TemplateContext): GeneratedFile[] {
  const { manifest, className } = ctx;
  const tag = manifest.tag;
  const slot = firstContextSlot(manifest);

  const app = `import { defineComponent, h } from 'vue';
import { useRecord, useSettings } from '@gridmason/sdk/vue';

// The widget's Vue component. A plain-ESM render function (no SFC) so the entry
// loads with no build step; add \`.vue\` files + your bundler when you want richer
// authoring. Data access uses the @gridmason/sdk Vue composables over the host
// handle — every composable bottoms out in an SDK method, so the widget stays
// auditable. The composables return refs the render function unwraps with \`.value\`.
export const App = defineComponent({
  props: {
    sdk: { type: Object, required: true },
  },
  setup(props) {
    // The primary context record (manifest \`requiresContext.${slot}\`); the composable
    // returns reactive refs and reads an idle result when the slot is absent.
    const { status } = useRecord(props.sdk, props.sdk.context['${slot}']);
    const [settings] = useSettings(props.sdk);
    return () =>
      h('section', { class: 'gm-widget' }, [
        h('h1', settings.value.title ? String(settings.value.title) : '${manifest.name}'),
        h('p', 'Primary record (${slot}): ' + status.value + '.'),
      ]);
  },
});
`;

  const entry = `// ${manifest.name} — Vue Gridmason widget.
//
// A plain ES module registering the custom element below. It hosts a Vue app and
// implements the widget ABI (core §4): the four host attributes in, CustomEvents
// out, the capability-scoped SDK handle read from \`.sdk\`.
import { createApp } from 'vue';
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
    this._app = null;
    this._mount = null;
  }

  set sdk(handle) {
    this._sdk = handle;
    this._mountApp();
  }

  get sdk() {
    return this._sdk ?? this._ensureSdk();
  }

  connectedCallback() {
    this._mount = document.createElement('div');
    this.appendChild(this._mount);
    this._mountApp();
    emit(this, '${READY_EVENT}', { tag: '${tag}', instanceId: readHostState(this).instanceId });
  }

  disconnectedCallback() {
    this._unmountApp();
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

  _unmountApp() {
    if (this._app) {
      this._app.unmount();
      this._app = null;
    }
  }

  // (Re)create the Vue app bound to the current handle. Recreating on rebind
  // re-runs the composables' setup against the new handle (Vue setup runs once),
  // the composables release their subscriptions on scope dispose at unmount.
  _mountApp() {
    if (!this._mount) return;
    this._unmountApp();
    this._app = createApp(App, { sdk: this._ensureSdk() });
    this._app.mount(this._mount);
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
