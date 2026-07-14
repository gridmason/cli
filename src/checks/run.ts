/**
 * The check registry and the runner (SPEC §5, §8; FR-7, FR-8).
 *
 * `checks` is the ordered set of every review check `gridmason lint` and the
 * registry run. It is the single source the check-id reference page (#14) is
 * generated from and the extension point the later L-E2 checks append to
 * (SDK-adherence #12, dependency-DAG #13). `runChecks` applies them to one
 * {@link CheckContext} and returns the flat findings; the caller shapes the human
 * / `--json` report (the full structured report + tier mapping is #13).
 */
import { dependencyDagCheck } from './deps.js';
import { domChecks } from './dom.js';
import { manifestChecks } from './manifest.js';
import { sdkChecks } from './sdk.js';
import type { Check, CheckContext, CheckResult } from './types.js';

/**
 * Every review check, in report order (SPEC §5): the manifest-lint checks (#11),
 * then the SDK-adherence checks (#12), the dependency-DAG check (#13), and the
 * DOM-abuse check (#12). The registry imports this array verbatim so its automated
 * review and local lint run the identical code (SPEC §8).
 */
export const checks: readonly Check[] = [...manifestChecks, ...sdkChecks, dependencyDagCheck, ...domChecks];

/**
 * Run `toRun` (every registered check by default) against `ctx` and collect their
 * findings in check order. Pure: a check never throws, so this never does.
 */
export function runChecks(ctx: CheckContext, toRun: readonly Check[] = checks): CheckResult[] {
  return toRun.flatMap((check) => check.run(ctx));
}

/** Whether any finding failed — the signal `publish` fails closed on (SPEC §8). */
export function hasFailure(results: readonly CheckResult[]): boolean {
  return results.some((result) => result.status === 'fail');
}
