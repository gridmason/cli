/**
 * E2e global setup: build the `gridmason` binary once before the e2e suite runs.
 *
 * The e2e drives the *shipped* artifact (`dist/bin/gridmason.js`) as a real
 * subprocess, not the TS source in-process — so it only means anything against a
 * fresh build of the current tree. Building here (once, before any e2e file)
 * guarantees the binary under test reflects the source under review: a
 * regression in any check surfaces as an e2e failure rather than passing against
 * a stale `dist/`. CI runs this same path, so its e2e job needs no separate
 * build step.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function setup(): void {
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    // npm resolves to npm.cmd on Windows runners.
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    throw new Error(
      `e2e setup: \`npm run build\` failed (exit ${build.status}).\n${build.stdout ?? ''}${build.stderr ?? ''}`,
    );
  }
}
