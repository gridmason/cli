/**
 * The `init` scaffold templates (SPEC §3). A template owns the *framework-specific*
 * files of a scaffolded project — the ABI-conformant custom-element skeleton and
 * the plain ES-module `entry` that registers it, consuming the host handle via
 * `@gridmason/sdk` helpers (core §4): **vanilla** (bundler-free reference, GW-D22),
 * **React**, and **Vue**. Framework choice also sets the manifest `sharedScope`
 * defaults (the import-map ranges the host must satisfy).
 *
 * This module is the seam the L-E1 templates issue (#7) fills: the registry and
 * the `Template` shape are defined here, and `widget init` (#6) drives them, but
 * the real per-framework bodies land in #7. Until then every framework shares a
 * minimal placeholder `entry` so the scaffold is exercisable end to end.
 */
import type { Manifest } from '@gridmason/protocol';

/** The starter frameworks `widget init` offers (SPEC §3). */
export type Framework = 'vanilla' | 'react' | 'vue';

/** The frameworks in prompt order. */
export const FRAMEWORKS: readonly Framework[] = ['vanilla', 'react', 'vue'];

/** A single file the scaffold writes, addressed POSIX-style from the project root. */
export interface GeneratedFile {
  /** Project-relative path, forward-slashed (e.g. `src/entry.js`). */
  path: string;
  /** Full file contents. */
  contents: string;
}

/** Everything a template needs to emit its files. */
export interface TemplateContext {
  /** The generated manifest stub (its `tag`/`entry` are already resolved). */
  manifest: Manifest;
  /** The chosen framework. */
  framework: Framework;
  /** Slugified project name — the project directory base and tag suffix. */
  slug: string;
  /** PascalCase class name for the custom element, derived from the slug. */
  className: string;
}

/** A framework starter: static metadata plus the files it emits. */
export interface Template {
  framework: Framework;
  /** One-line label shown at the `widget init` framework prompt. */
  description: string;
  /** Project-relative path of the ES-module `entry` this template emits. */
  entryPath: string;
  /**
   * Import-map ranges the host must satisfy at resolve time; omitted for a
   * fully self-contained module graph (the vanilla default).
   */
  sharedScope?: Record<string, string>;
  /**
   * The framework-specific files: the ABI custom-element skeleton + `entry`.
   * #7 replaces the placeholder bodies with the real per-framework skeletons.
   */
  files(ctx: TemplateContext): GeneratedFile[];
}

/** Where every template writes its entry until #7 gives each its own layout. */
const ENTRY_PATH = 'src/entry.js';

/**
 * A minimal, valid ES-module `entry` that registers the custom element — the
 * placeholder body shared by all frameworks until #7 writes the real ABI
 * skeletons. It defines the element so the scaffold's shapes (a registered tag,
 * a plain ES module at `entry`) hold before the framework bodies exist.
 */
function placeholderEntry(tag: string): string {
  return `// Scaffold placeholder entry — the real ABI skeleton lands in issue #7.
//
// The shipped template will implement the widget ABI (core §4): read
// context/settings/instance-id/edit-mode attributes, emit CustomEvents, and
// obtain the host handle through @gridmason/sdk helpers. For now this registers
// a minimal element so the project scaffolds, serves, and lints out of the box.

class GridmasonWidgetElement extends HTMLElement {
  connectedCallback() {
    this.textContent = '${tag}: scaffold placeholder — implement the ABI skeleton (issue #7).';
  }
}

if (!customElements.get('${tag}')) {
  customElements.define('${tag}', GridmasonWidgetElement);
}
`;
}

/** The placeholder `files()` every framework shares until #7 lands. */
function placeholderFiles(ctx: TemplateContext): GeneratedFile[] {
  return [{ path: ENTRY_PATH, contents: placeholderEntry(ctx.manifest.tag) }];
}

/** The registered templates, keyed by framework. */
export const templates: Record<Framework, Template> = {
  vanilla: {
    framework: 'vanilla',
    description: 'Vanilla — no framework, bundler-free reference (GW-D22)',
    entryPath: ENTRY_PATH,
    files: placeholderFiles,
  },
  react: {
    framework: 'react',
    description: 'React',
    entryPath: ENTRY_PATH,
    sharedScope: { react: '^18.0.0', 'react-dom': '^18.0.0' },
    files: placeholderFiles,
  },
  vue: {
    framework: 'vue',
    description: 'Vue 3',
    entryPath: ENTRY_PATH,
    sharedScope: { vue: '^3.0.0' },
    files: placeholderFiles,
  },
};

/** Resolve a template by framework. */
export function getTemplate(framework: Framework): Template {
  return templates[framework];
}
