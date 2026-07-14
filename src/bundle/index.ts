/**
 * The `bundle` command's engine (SPEC §2, FR-13): produce and inspect signed
 * offline `.gmb` archives (protocol §4.5). `export` repackages an already-signed
 * release plus the project's servable bytes into a self-sealing bundle and
 * self-verifies it; `inspect` reads one back and prints its contents and offline
 * verdict. Both are thin over the `verify --offline` machinery and
 * `@gridmason/protocol` — the CLI mints no crypto and signs nothing here.
 */
export { assembleBundle, type SignedRelease, type AssembleInput, type AssembleResult, type AssembleErrorCode } from './pack.js';
export {
  runBundleExport,
  type BundleExportDeps,
  type BundleExportArgs,
  type ExportRender,
} from './export.js';
export {
  runBundleInspect,
  type BundleInspectDeps,
  type BundleInspectArgs,
  type InspectRender,
} from './inspect.js';
