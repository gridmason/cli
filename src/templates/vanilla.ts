/**
 * The **vanilla** template (SPEC §3, GW-D22): the bundler-free reference. A
 * single hand-written ES module registers the custom element and speaks the
 * widget ABI directly against the DOM — no framework, no build step, a fully
 * self-contained module graph (hence no `sharedScope`). It loads as-is in a bare
 * import-map harness with an empty map, which is what makes it the reference the
 * React and Vue templates are measured against.
 */
import { ACTION_EVENT, READY_EVENT, abiRuntimeSource, observedAttributesLiteral } from './abi.js';
import type { GeneratedFile, TemplateContext } from './index.js';

/** Emit the vanilla template's files: a single self-contained `entry`. */
export function vanillaFiles(ctx: TemplateContext): GeneratedFile[] {
  const { manifest, className } = ctx;
  const tag = manifest.tag;
  const contents = `// ${manifest.name} — vanilla Gridmason widget (bundler-free reference).
//
// A plain ES module: no framework, no build step. It registers the custom
// element below and implements the widget ABI (core §4) directly — the four
// host attributes in, CustomEvents out. Data access flows through the
// capability-scoped SDK handle the host assigns to \`.sdk\`; wrap it with the
// \`@gridmason/sdk\` helpers when you add real logic (see the project README).

${abiRuntimeSource()}

class ${className}Element extends HTMLElement {
  static get observedAttributes() {
    return ${observedAttributesLiteral()};
  }

  constructor() {
    super();
    this._sdk = null;
  }

  // Host -> widget: the capability-scoped SDK handle. All privileged I/O goes
  // through it; the @gridmason/sdk helpers are ergonomics over this handle.
  set sdk(handle) {
    this._sdk = handle;
    this._render();
  }

  get sdk() {
    return this._sdk;
  }

  connectedCallback() {
    this._render();
    // Widget -> host: announce the mount so the host can wire the handle.
    emit(this, '${READY_EVENT}', { tag: '${tag}', instanceId: readHostState(this).instanceId });
  }

  attributeChangedCallback() {
    this._render();
  }

  _render() {
    if (!this.isConnected) return;
    const state = readHostState(this);
    this.replaceChildren();

    const root = document.createElement('section');
    root.className = 'gm-widget';

    const title = document.createElement('h1');
    title.textContent = '${manifest.name}';
    root.appendChild(title);

    const status = document.createElement('p');
    status.textContent = this._sdk
      ? 'Connected to the host SDK.'
      : 'No host SDK yet — rendering from attributes. Run \`gridmason dev\`.';
    root.appendChild(status);

    // Widget -> host: a sample outbound action event.
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Send action';
    button.addEventListener('click', () => emit(this, '${ACTION_EVENT}', { source: '${tag}', state }));
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
