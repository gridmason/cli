/**
 * The **Vue** template (SPEC §3; heritage from `vue3-widget-template`). A custom
 * element hosts a Vue app; the component is authored as a plain-ESM render
 * function (`h`, no single-file component) so the emitted `entry` loads in a bare
 * import-map harness with **no build step** — the author adds `.vue` SFCs and a
 * bundler when they want (the CLI is not a bundler, GW-D22). `vue` is declared in
 * the manifest `sharedScope`, so the host satisfies it from its import map.
 *
 * Host state is held in a single `reactive` object passed as the root component's
 * `state` prop; the element mutates it on attribute change and on `sdk` handoff,
 * and Vue re-renders — no remount per update.
 */
import { READY_EVENT, abiRuntimeSource, observedAttributesLiteral } from './abi.js';
import type { GeneratedFile, TemplateContext } from './index.js';

/** Emit the Vue template's files: the ABI element `entry` plus the component. */
export function vueFiles(ctx: TemplateContext): GeneratedFile[] {
  const { manifest, className } = ctx;
  const tag = manifest.tag;

  const app = `import { defineComponent, h } from 'vue';

// The widget's Vue component. A plain-ESM render function (no SFC) so the entry
// loads with no build step; add \`.vue\` files + your bundler when you want richer
// authoring. It reads host state from the reactive \`state\` prop the element
// owns. Data access wraps \`state.sdk\` with the @gridmason/sdk Vue helpers, e.g.:
//   import { useRecord, useSettings } from '@gridmason/sdk/vue';
export const App = defineComponent({
  props: {
    state: { type: Object, required: true },
  },
  setup(props) {
    return () =>
      h('section', { class: 'gm-widget' }, [
        h('h1', '${manifest.name}'),
        h(
          'p',
          props.state.sdk
            ? 'Connected to the host SDK.'
            : 'No host SDK yet — rendering from attributes.',
        ),
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
import { App } from './app.js';

${abiRuntimeSource()}

class ${className}Element extends HTMLElement {
  static get observedAttributes() {
    return ${observedAttributesLiteral()};
  }

  constructor() {
    super();
    this._app = null;
    this._state = null;
    this._mount = null;
    this._pendingSdk = null;
  }

  set sdk(handle) {
    if (this._state) {
      this._state.sdk = handle;
    } else {
      this._pendingSdk = handle;
    }
  }

  get sdk() {
    return this._state ? this._state.sdk : this._pendingSdk;
  }

  connectedCallback() {
    this._mount = document.createElement('div');
    this.appendChild(this._mount);
    this._state = reactive({ ...readHostState(this), sdk: this._pendingSdk });
    this._app = createApp(App, { state: this._state });
    this._app.mount(this._mount);
    emit(this, '${READY_EVENT}', { tag: '${tag}', instanceId: this._state.instanceId });
  }

  disconnectedCallback() {
    if (this._app) {
      this._app.unmount();
      this._app = null;
    }
  }

  attributeChangedCallback() {
    // Mutate the reactive state in place so Vue re-renders without a remount.
    if (this._state) Object.assign(this._state, readHostState(this));
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
