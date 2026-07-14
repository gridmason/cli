/**
 * Write a planned scaffold to disk. Kept separate from planning (`files.ts`) so
 * the whole file set is unit-testable as pure data and only this thin layer
 * touches the filesystem.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GeneratedFile } from '../templates/index.js';
import { InitError } from './manifest.js';

/** True when `dir` exists and contains at least one entry. */
async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch (err) {
    // A missing directory is fine — we create it. Anything else is a real error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Write every file of a scaffold under `targetDir`, creating parent directories
 * as needed. Refuses to write into a non-empty directory (never clobbers an
 * existing project). Returns the absolute paths written, in file order.
 */
export async function writeProject(targetDir: string, files: GeneratedFile[]): Promise<string[]> {
  if (await isNonEmptyDir(targetDir)) {
    throw new InitError('dir-not-empty', `target directory "${targetDir}" already exists and is not empty`);
  }

  const written: string[] = [];
  for (const file of files) {
    const abs = path.join(targetDir, file.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, file.contents, 'utf8');
    written.push(abs);
  }
  return written;
}
