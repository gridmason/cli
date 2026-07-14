#!/usr/bin/env node
import { run } from '../cli.js';

// The `gridmason` binary entry (bin in package.json). Keep this thin: parse and
// dispatch, then set the exit code — all real work lives in the library so it
// stays unit-testable.
run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`gridmason: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
