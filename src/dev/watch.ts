/**
 * The `dev` file watcher (SPEC §4, FR-4). It watches the three things an author
 * edits mid-loop — the widget source, `manifest.json`, and `fixtures/` — and maps
 * each change to a {@link ReloadCategory} the server broadcasts to browsers. The
 * watcher never reads or caches file *contents*: the server always re-reads from
 * disk on the next request, so the watcher only needs to say *that* something
 * changed and *which kind*, and the browser re-asks (see `server.ts`).
 */
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { CONTEXTS_DIR, type DevProject, MANIFEST_FILE } from './project.js';
import type { ReloadCategory } from './server.js';

/** A running watcher; call {@link close} to stop it. */
export interface Watcher {
  close(): Promise<void>;
}

/**
 * Watch the project's source, manifest, and fixtures. `onReload` is called with
 * the category of each change once the watcher is ready (initial adds are
 * ignored). `paths` overrides the watched globs (a test seam).
 */
export function createWatcher(
  project: DevProject,
  onReload: (category: ReloadCategory) => void,
  paths: readonly string[] = ['src', 'fixtures', MANIFEST_FILE],
): Watcher {
  const watched = paths.map((p) => path.join(project.root, p));
  const watcher: FSWatcher = chokidar.watch(watched, { ignoreInitial: true });
  const onChange = (changed: string): void => onReload(categorize(project.root, changed));
  watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
  return {
    async close() {
      await watcher.close();
    },
  };
}

/**
 * Classify a changed path: the manifest re-validates, a `fixtures/contexts/` edit
 * swaps the mounted context, any other `fixtures/` edit swaps the fixture data,
 * and everything else (source) needs a fresh module graph.
 */
export function categorize(root: string, changed: string): ReloadCategory {
  const rel = path.relative(root, changed);
  if (rel === MANIFEST_FILE) return 'manifest';
  if (isInside(CONTEXTS_DIR, rel)) return 'context';
  if (isInside('fixtures', rel)) return 'fixtures';
  return 'source';
}

/** Whether `rel` is the directory `dir` itself or a path inside it. */
function isInside(dir: string, rel: string): boolean {
  return rel === dir || rel.startsWith(dir + path.sep);
}
