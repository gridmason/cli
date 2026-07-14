/**
 * The `init` scaffold templates (SPEC §3). A template owns the *framework-specific*
 * files of a scaffolded project — the ABI-conformant custom-element skeleton and
 * the plain ES-module `entry` that registers it, consuming the host handle via
 * `@gridmason/sdk` helpers (core §4): **vanilla** (bundler-free reference, GW-D22),
 * **React**, and **Vue**. Framework choice also sets the manifest `sharedScope`
 * defaults (the import-map ranges the host must satisfy).
 *
 * The registry and the `Template` shape live here; `widget init` (#6) drives them.
 * The per-framework bodies live in their own modules (`./vanilla`, `./react`,
 * `./vue`), all speaking the shared ABI in `./abi`. Every emitted `entry` is a
 * plain ES module that registers its custom element and loads in a bare
 * import-map harness with no bundler (`docs/templates.md`).
 */
import type { Manifest } from '@gridmason/protocol';
import { reactFiles } from './react.js';
import { vanillaFiles } from './vanilla.js';
import { vueFiles } from './vue.js';

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
  /** The framework-specific files: the ABI custom-element skeleton + `entry`. */
  files(ctx: TemplateContext): GeneratedFile[];
}

/** The ES-module `entry` every template registers its custom element from. */
const ENTRY_PATH = 'src/entry.js';

/** The registered templates, keyed by framework. */
export const templates: Record<Framework, Template> = {
  vanilla: {
    framework: 'vanilla',
    description: 'Vanilla — no framework, bundler-free reference (GW-D22)',
    entryPath: ENTRY_PATH,
    files: vanillaFiles,
  },
  react: {
    framework: 'react',
    description: 'React',
    entryPath: ENTRY_PATH,
    sharedScope: { react: '^18.0.0', 'react-dom': '^18.0.0' },
    files: reactFiles,
  },
  vue: {
    framework: 'vue',
    description: 'Vue 3',
    entryPath: ENTRY_PATH,
    sharedScope: { vue: '^3.0.0' },
    files: vueFiles,
  },
};

/** Resolve a template by framework. */
export function getTemplate(framework: Framework): Template {
  return templates[framework];
}
