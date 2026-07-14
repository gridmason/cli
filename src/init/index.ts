/**
 * `widget init` orchestration (SPEC §3, FR-2): resolve the answers (from flags or
 * interactive prompts), plan the scaffold, write it, and report the result. The
 * pure pieces live in `manifest.ts` / `files.ts`; this module wires them to the
 * prompter, the filesystem, and the CLI's IO sink.
 */
import path from 'node:path';
import type { ManifestKind } from '@gridmason/protocol';
import type { IO } from '../io.js';
import { FRAMEWORKS, type Framework } from '../templates/index.js';
import { InitError, type InitAnswers } from './manifest.js';
import { planScaffold } from './files.js';
import { writeProject } from './scaffold.js';
import { createReadlinePrompter, type Prompter } from './prompter.js';

/** The allowed `--kind` values (mirrors `ManifestKind`). */
const KINDS: readonly ManifestKind[] = ['widget', 'plugin', 'page-type', 'layout'];

/**
 * Options `runInit` accepts (the command's flags plus test seams). The fields
 * allow explicit `undefined` because commander hands the action `undefined` for
 * an unset argument/flag under `exactOptionalPropertyTypes`.
 */
export interface InitOptions {
  /** Widget name (the command's `[name]` argument). */
  name?: string | undefined;
  /** Publisher prefix (`--publisher`). */
  publisher?: string | undefined;
  /** Artifact kind (`--kind`), defaulted by the command to `widget`. */
  kind?: string | undefined;
  /** Starter framework (`--framework`), defaulted by the command to `vanilla`. */
  framework?: string | undefined;
  /** Emit machine-readable JSON (`--json`). */
  json?: boolean | undefined;
  /** Base directory to scaffold into; defaults to the process cwd. (test seam) */
  cwd?: string | undefined;
}

/** Injectable dependencies so tests drive `init` without a terminal. */
export interface InitDeps {
  /** Whether to run interactively; defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
  /** The prompter to use when interactive; defaults to a readline prompter. */
  prompter?: Prompter;
}

function parseKind(value: string | undefined): ManifestKind {
  const kind = (value ?? 'widget') as ManifestKind;
  if (!KINDS.includes(kind)) {
    throw new InitError('invalid-option', `unknown kind "${value}" (expected one of: ${KINDS.join(', ')})`);
  }
  return kind;
}

function parseFramework(value: string | undefined): Framework {
  const framework = (value ?? 'vanilla') as Framework;
  if (!FRAMEWORKS.includes(framework)) {
    throw new InitError(
      'invalid-option',
      `unknown framework "${value}" (expected one of: ${FRAMEWORKS.join(', ')})`,
    );
  }
  return framework;
}

/** Resolve the four answers from flags, prompting for the missing ones when interactive. */
async function resolveAnswers(opts: InitOptions, deps: InitDeps): Promise<InitAnswers> {
  const interactive = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const name = opts.name?.trim();
  const publisher = opts.publisher?.trim();

  if (!interactive) {
    if (!name) {
      throw new InitError('missing-answer', 'a widget name is required (pass it as the first argument)');
    }
    if (!publisher) {
      throw new InitError('missing-answer', 'a publisher prefix is required (pass --publisher)');
    }
    return { name, publisher, kind: parseKind(opts.kind), framework: parseFramework(opts.framework) };
  }

  const prompter = deps.prompter ?? createReadlinePrompter();
  try {
    const resolvedName =
      name || (await prompter.text({ message: 'Widget name', validate: (v) => (v ? true : 'a name is required') }));
    const resolvedPublisher =
      publisher ||
      (await prompter.text({
        message: 'Publisher prefix',
        validate: (v) => (/^[a-z][a-z0-9-]*$/.test(v) ? true : 'lowercase, start with a letter, [a-z0-9-] only'),
      }));
    const kind = await prompter.select({
      message: 'Kind',
      choices: KINDS.map((k) => ({ value: k, label: k })),
      default: parseKind(opts.kind),
    });
    const framework = await prompter.select({
      message: 'Framework',
      choices: FRAMEWORKS.map((f) => ({ value: f, label: f })),
      default: parseFramework(opts.framework),
    });
    return { name: resolvedName, publisher: resolvedPublisher, kind, framework };
  } finally {
    prompter.close();
  }
}

/**
 * Run `widget init`. Reports its own output (human on stderr, JSON on stdout) and
 * returns a process exit code — `0` on success, `1` on an {@link InitError}. Any
 * other error propagates (a real fault, surfaced by the binary's catch-all).
 */
export async function runInit(opts: InitOptions, io: IO, deps: InitDeps = {}): Promise<number> {
  let answers: InitAnswers;
  try {
    answers = await resolveAnswers(opts, deps);
  } catch (err) {
    return reportError(err, io, opts.json);
  }

  let scaffold;
  try {
    scaffold = planScaffold(answers);
  } catch (err) {
    return reportError(err, io, opts.json);
  }

  const targetDir = path.resolve(opts.cwd ?? process.cwd(), scaffold.directory);
  try {
    await writeProject(targetDir, scaffold.files);
  } catch (err) {
    return reportError(err, io, opts.json);
  }

  const relFiles = scaffold.files.map((f) => f.path).sort();
  if (opts.json) {
    io.out(
      `${JSON.stringify({
        command: 'widget init',
        status: 'created',
        directory: scaffold.directory,
        tag: scaffold.manifest.tag,
        framework: answers.framework,
        files: relFiles,
      })}\n`,
    );
  } else {
    io.err(`Scaffolded ${scaffold.manifest.kind} "${scaffold.manifest.tag}" in ${scaffold.directory}/\n`);
    for (const file of relFiles) {
      io.err(`  ${scaffold.directory}/${file}\n`);
    }
    io.err(`\nNext:\n  cd ${scaffold.directory}\n  npm install\n  gridmason dev\n`);
  }
  return 0;
}

/** Report an error (JSON on stdout, human on stderr) and return exit code 1; rethrow non-InitErrors. */
function reportError(err: unknown, io: IO, jsonMode: boolean | undefined): number {
  if (!(err instanceof InitError)) {
    throw err;
  }
  if (jsonMode) {
    io.out(`${JSON.stringify({ command: 'widget init', status: 'error', code: err.code, message: err.message })}\n`);
  } else {
    io.err(`gridmason: ${err.message}\n`);
  }
  return 1;
}
