/**
 * The **Vue** template (SPEC §3; heritage from `vue3-widget-template`). A custom
 * element hosts a Vue app; the component is authored as a plain-ESM render
 * function (`h`, no single-file component) so the emitted `entry` loads in a bare
 * import-map harness with **no build step** — the author adds `.vue` SFCs and a
 * bundler when they want (the CLI is not a bundler, GW-D22). `vue` is declared in
 * the manifest `sharedScope`, so the host satisfies it from its import map.
 *
 * It consumes the real `@gridmason/sdk` **shared-core** reactive sources
 * (`recordSource`, `settingsSource`) — bridged into a Vue `reactive` snapshot the
 * component renders from (the dedicated `@gridmason/sdk/vue` composables land with
 * SDK issue #10). The element wires the host handle from `.sdk`, falling back to
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

// The widget's Vue component. A plain-ESM render function (no SFC) so the entry
// loads with no build step; add \`.vue\` files + your bundler when you want richer
// authoring. It renders from the reactive \`state\` snapshot the element bridges
// from the @gridmason/sdk shared-core sources.
export const App = defineComponent({
  props: {
    state: { type: Object, required: true },
  },
  setup(props) {
    return () =>
      h('section', { class: 'gm-widget' }, [
        h('h1', props.state.title || '${manifest.name}'),
        h('p', 'Primary record (${slot}): ' + props.state.recordStatus + '.'),
      ]);
  },
});
`;

  const entry = `// ${manifest.name} — Vue Gridmason widget.
//
// A plain ES module registering the custom element below. It hosts a Vue app and
// implements the widget ABI (core §4): the four host attributes in, CustomEvents
// out, the capability-scoped SDK handle read from \`.sdk\`.
import { createApp, reactive } from 'vue';
import { recordSource, settingsSource } from '@gridmason/sdk';
import { createNoopSDK } from '@gridmason/sdk/noop';
import { App } from './app.js';

${abiRuntimeSource()}

const CONTEXT_SLOT = '${slot}';

class ${className}Element extends HTMLElement {
  static get observedAttributes() {
    return ${observedAttributesLiteral()};
  }

  constructor() {
    super();
    this._sdk = null;
    this._app = null;
    this._mount = null;
    this._state = null;
    this._records = null;
    this._settings = null;
    this._unsubscribe = [];
  }

  set sdk(handle) {
    this._sdk = handle;
    this._bind();
  }

  get sdk() {
    return this._sdk ?? this._ensureSdk();
  }

  connectedCallback() {
    this._mount = document.createElement('div');
    this.appendChild(this._mount);
    this._state = reactive({ title: '', recordStatus: 'idle' });
    this._app = createApp(App, { state: this._state });
    this._app.mount(this._mount);
    this._bind();
    emit(this, '${READY_EVENT}', { tag: '${tag}', instanceId: readHostState(this).instanceId });
  }

  disconnectedCallback() {
    this._teardown();
    if (this._app) {
      this._app.unmount();
      this._app = null;
    }
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

  // (Re)bind the shared-core sources to the current handle and mirror their
  // snapshots into the reactive Vue state on every change.
  _bind() {
    if (!this._state) return;
    this._teardown();
    const sdk = this._ensureSdk();
    this._records = recordSource(sdk, sdk.context[CONTEXT_SLOT]);
    this._settings = settingsSource(sdk);
    const sync = () => {
      const settings = this._settings.getSnapshot();
      this._state.title = settings.title ? String(settings.title) : '';
      this._state.recordStatus = this._records.getSnapshot().status;
    };
    this._unsubscribe.push(this._records.subscribe(sync));
    this._unsubscribe.push(this._settings.subscribe(sync));
    sync();
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
