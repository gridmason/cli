// @vitest-environment happy-dom
/// <reference lib="dom" />
/**
 * Template harness (issue #7, FR-2). Proves the acceptance criterion for each
 * starter framework: **the emitted `entry` loads in a bare import-map harness
 * (no bundler, no dashboard) and registers its custom-element tag.**
 *
 * Harness: a headless DOM (`happy-dom`) plus native dynamic `import()`. Each
 * template's files are written to a scratch dir and the `entry` is imported as a
 * plain ES module — no bundler in the loop. `react`/`react-dom`/`vue` (the
 * `sharedScope` specifiers the React and Vue entries import) resolve from the
 * repo's `node_modules`, standing in for the shared modules a host would supply
 * through its import map. The vanilla entry is self-contained and needs no map.
 * Once loaded, we assert the tag is defined, the element mounts into the DOM,
 * and it emits the `gridmason:ready` ABI event.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifestStub, slugify, toClassName, type InitAnswers } from '../src/init/manifest.js';
import { FRAMEWORKS, getTemplate, type Framework, type TemplateContext } from '../src/templates/index.js';

// The Vue esm-bundler build reads these compile-time feature flags as globals;
// a real bundler (or import map to the browser build) defines them. Set them so
// the unbundled `vue` entry evaluates in the harness. Harmless for the others.
const g = globalThis as Record<string, unknown>;
g['__VUE_OPTIONS_API__'] = true;
g['__VUE_PROD_DEVTOOLS__'] = false;
g['__VUE_PROD_HYDRATION_MISMATCH_DETAILS__'] = false;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Scratch lives under node_modules so bare specifiers resolve up to the repo's
// node_modules and nothing lands in git.
const scratchBase = path.join(repoRoot, 'node_modules', '.cache', 'gm-template-harness');

/** Wait for `predicate` to hold, polling microtasks (React renders async). */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Build the template context the scaffold would pass, for a given framework. */
function contextFor(framework: Framework): TemplateContext {
  const answers: InitAnswers = { name: `${framework} widget`, publisher: 'acme', kind: 'widget', framework };
  const manifest = buildManifestStub(answers);
  const slug = slugify(answers.name);
  return { manifest, framework, slug, className: toClassName(slug) };
}

describe.each(FRAMEWORKS)('template: %s', (framework) => {
  let dir: string;

  beforeEach(async () => {
    await mkdir(scratchBase, { recursive: true });
    dir = await mkdtemp(path.join(scratchBase, `${framework}-`));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write the template's files into the scratch dir and import the entry module. */
  async function loadEntry(ctx: TemplateContext): Promise<void> {
    const files = getTemplate(framework).files(ctx);
    for (const file of files) {
      const abs = path.join(dir, file.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, file.contents, 'utf8');
    }
    await import(pathToFileURL(path.join(dir, 'src', 'entry.js')).href);
  }

  it('emits a plain ES-module entry (and its component) with a self-contained src layout', () => {
    const files = getTemplate(framework).files(contextFor(framework));
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/entry.js');
    // Every emitted file is a plain .js ES module under src/ (no build artifacts).
    for (const p of paths) {
      expect(p.startsWith('src/')).toBe(true);
      expect(p.endsWith('.js')).toBe(true);
    }
  });

  it('declares the expected sharedScope for its framework', () => {
    const { sharedScope } = getTemplate(framework);
    if (framework === 'vanilla') expect(sharedScope).toBeUndefined();
    if (framework === 'react') expect(sharedScope).toEqual({ react: '^18.0.0', 'react-dom': '^18.0.0' });
    if (framework === 'vue') expect(sharedScope).toEqual({ vue: '^3.0.0' });
  });

  it('loads in the bare import-map harness and registers its custom-element tag', async () => {
    const ctx = contextFor(framework);
    const { tag } = ctx.manifest;
    expect(customElements.get(tag)).toBeUndefined();

    await loadEntry(ctx);

    // The entry registered the publisher-prefixed tag as a custom element.
    expect(customElements.get(tag)).toBeTypeOf('function');
  });

  it('mounts into the DOM and emits the gridmason:ready ABI event', async () => {
    const ctx = contextFor(framework);
    const { tag } = ctx.manifest;
    await loadEntry(ctx);

    const el = document.createElement(tag);
    el.setAttribute('instance-id', 'inst-42');
    el.setAttribute('context', JSON.stringify({ primary: { id: 'example:1' } }));

    let ready: CustomEvent | undefined;
    el.addEventListener('gridmason:ready', (e) => {
      ready = e as CustomEvent;
    });
    document.body.appendChild(el);

    // The ready event fires synchronously on connect, carrying the mount identity.
    expect(ready).toBeDefined();
    expect((ready as CustomEvent).detail).toMatchObject({ tag, instanceId: 'inst-42' });
    expect((ready as CustomEvent).bubbles).toBe(true);

    // The widget rendered its ABI skeleton (React flushes on a microtask).
    await waitFor(() => el.querySelector('h1') !== null);
    expect(el.querySelector('h1')?.textContent).toBe(`${framework} widget`);

    el.remove();
  });
});
