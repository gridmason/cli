/**
 * `gridmason appeal <artifact>` orchestration (SPEC §7; registry §4): route a
 * submission that a first review rejected to a **second reviewer** (never the
 * original — the reviewer≠author / reviewer≠reviewer rule is the registry's, this
 * only requests the routing). `<artifact>` is the artifact id `publish` printed.
 *
 * Like `publish`, every external effect is injected so the flow is drivable
 * against a local/fake registry in a test; the command wires the production deps.
 */
import type { IO } from '../io.js';
import { IdentityError, type AcquiredIdentity } from './identity.js';
import { reportIdentityError } from './login.js';
import { appealArtifact, type RegistryClientDeps } from './upload.js';

/** Everything `runAppeal` needs from the outside world — injected for testing. */
export interface AppealDeps {
  acquireIdentity(): Promise<AcquiredIdentity>;
  client: RegistryClientDeps;
}

/** The parsed arguments an `appeal` invocation supplies. */
export interface AppealArgs {
  /** The artifact id to appeal (the id `publish` printed). */
  artifact: string;
  /** Target registry base URL (`--registry`). Required. */
  registry?: string | undefined;
  /** Emit machine-readable JSON (`--json`). */
  json?: boolean | undefined;
}

function emitJson(io: IO, payload: Record<string, unknown>): void {
  io.out(`${JSON.stringify(payload)}\n`);
}

/**
 * Run `gridmason appeal`. Returns the process exit code: `0` when the appeal was
 * accepted and a second review is queued, `1` on any refusal (identity, no
 * registry, a registry error such as the artifact not being in an appealable
 * state).
 */
export async function runAppeal(deps: AppealDeps, args: AppealArgs, io: IO): Promise<number> {
  const json = args.json ?? false;

  if (!args.registry) {
    const message = 'no target registry — pass --registry <url> (there is no default registry yet)';
    if (json) emitJson(io, { command: 'appeal', status: 'error', code: 'no-registry', message });
    else io.err(`gridmason: ${message}\n`);
    return 1;
  }

  let acquired: AcquiredIdentity;
  try {
    acquired = await deps.acquireIdentity();
  } catch (err) {
    if (err instanceof IdentityError) return reportIdentityError(err, io, json, 'appeal');
    throw err;
  }

  const result = await appealArtifact(deps.client, { registry: args.registry, token: acquired.token, id: args.artifact });
  if (!result.ok) {
    const { code, message, httpStatus } = result.error;
    if (json) emitJson(io, { command: 'appeal', status: 'error', code, message, httpStatus, artifact: args.artifact });
    else io.err(`gridmason: appeal rejected (${code}): ${message}\n`);
    return 1;
  }

  const record = result.value;
  if (json) {
    emitJson(io, { command: 'appeal', status: 'appealed', artifact: `${record.tag}@${record.version}`, id: record.id, state: record.state });
  } else {
    io.err(`Appealed ${record.tag}@${record.version} (id ${record.id}) — routed to a second reviewer (now ${record.state}).\n`);
  }
  return 0;
}
