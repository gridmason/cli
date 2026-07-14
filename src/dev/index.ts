/**
 * `gridmason dev` orchestration (SPEC §4, FR-4/FR-5): resolve the project, start
 * the HTTP server, watch the source/manifest/fixtures, and run until interrupted.
 * The pure pieces live in `project.ts` / `server.ts` / `watch.ts` / `proxy.ts` /
 * `harness.ts`; this module wires them together and reports through the CLI's IO
 * sink. It fails fast on the two things it can check up front — no project
 * manifest, and a `--context` preset that does not exist — before it ever binds a
 * port, so an author gets an immediate, exit-code'd error rather than a running
 * server that cannot mount anything.
 */
import { fileURLToPath } from 'node:url';
import type { IO } from '../io.js';
import { DevProjectError, loadContext, loadManifest, resolveProject } from './project.js';
import { type DevServer, createDevServer } from './server.js';
import { createWatcher } from './watch.js';

/** The `dev` command options (its flags plus test seams). */
export interface DevOptions {
  /** Project directory to serve; defaults to the process cwd. */
  cwd?: string | undefined;
  /** Port to listen on (`--port`); defaults to `3000`. `0` lets the OS assign one. */
  port?: number | undefined;
  /** A `--context <name>` preset to mount instead of `default.json`'s context. */
  context?: string | undefined;
  /** A `--proxy <host-url>` to forward SDK calls to (capability checks enforced). */
  proxy?: string | undefined;
  /** Emit machine-readable JSON (`--json`). */
  json?: boolean | undefined;
}

/** Injectable seams so a test can start `dev` and shut it down deterministically. */
export interface DevDeps {
  /** Aborting this signal shuts the server down (in place of SIGINT). */
  signal?: AbortSignal;
  /** Called once the server is listening — a test grabs the running server here. */
  onListening?: (server: DevServer) => void;
}

/** The CLI package root, used by the server to resolve `@gridmason/*` browser ESM. */
const CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Run `gridmason dev`. Reports its own output (human on stderr, JSON on stdout)
 * and resolves with a process exit code — `0` on a clean shutdown, `1` on a
 * {@link DevProjectError} caught before the server starts. Blocks (serving) until
 * SIGINT/SIGTERM or `deps.signal` aborts.
 */
export async function runDev(opts: DevOptions, io: IO, deps: DevDeps = {}): Promise<number> {
  const project = resolveProject(opts.cwd ?? process.cwd());

  // Fail fast: not a widget project (no manifest), or a typo'd --context preset.
  const manifest = await loadManifest(project);
  if (manifest.raw === null) {
    return reportError(new DevProjectError('no-manifest', 'no manifest.json here — run `gridmason widget init` first'), io, opts.json);
  }
  if (opts.context !== undefined) {
    try {
      await loadContext(project, opts.context);
    } catch (err) {
      return reportError(err, io, opts.json);
    }
  }
  if (opts.proxy !== undefined && !isValidUrl(opts.proxy)) {
    return reportError(new DevProjectError('context-invalid', `--proxy is not a valid URL: ${opts.proxy}`), io, opts.json);
  }

  const server = await createDevServer({
    project,
    port: opts.port ?? 3000,
    cliRoot: CLI_ROOT,
    ...(opts.context !== undefined ? { contextName: opts.context } : {}),
    ...(opts.proxy !== undefined ? { proxyUrl: opts.proxy } : {}),
  });

  const watcher = createWatcher(project, (category) => {
    if (category === 'manifest') {
      void loadManifest(project).then((state) => {
        if (!state.valid) io.err(`gridmason: manifest.json has issues: ${state.violations.join('; ')}\n`);
      });
    }
    server.reload(category);
  });

  reportListening(server, opts, manifest.manifest?.tag ?? '(unnamed)', io);
  deps.onListening?.(server);

  await waitForShutdown(deps.signal);

  await watcher.close();
  await server.close();
  return 0;
}

/** Report the listening server (JSON on stdout when `--json`, human on stderr). */
function reportListening(server: DevServer, opts: DevOptions, tag: string, io: IO): void {
  const mode = opts.proxy ? 'proxy' : 'fixture';
  if (opts.json) {
    io.out(
      `${JSON.stringify({
        command: 'dev',
        status: 'listening',
        url: server.url,
        tag,
        mode,
        ...(opts.context !== undefined ? { context: opts.context } : {}),
      })}\n`,
    );
    return;
  }
  io.err(`gridmason dev — serving ${tag} on ${server.url}\n`);
  io.err(`  mode: ${mode}${opts.proxy ? ` (${opts.proxy})` : ''}${opts.context ? `, context: ${opts.context}` : ''}\n`);
  io.err(`  open ${server.url} for the fixture harness, or sideload the entry from the dashboard\n`);
  io.err(`  watching src/, manifest.json, fixtures/ — edits hot-reload. Ctrl-C to stop.\n`);
}

/** Resolve when the server should shut down: an aborted signal or SIGINT/SIGTERM. */
function waitForShutdown(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Whether `value` parses as an absolute URL. */
function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Report a {@link DevProjectError} (JSON on stdout, human on stderr) → exit 1; rethrow others. */
function reportError(err: unknown, io: IO, jsonMode: boolean | undefined): number {
  if (!(err instanceof DevProjectError)) throw err;
  if (jsonMode) {
    io.out(`${JSON.stringify({ command: 'dev', status: 'error', code: err.code, message: err.message })}\n`);
  } else {
    io.err(`gridmason: ${err.message}\n`);
  }
  return 1;
}
