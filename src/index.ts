/**
 * Public library surface of `@gridmason/cli`. The package is primarily a binary
 * (`gridmason`), but it also exposes the program builder for embedding/testing
 * and re-exports the shared checks module (also available at the `./checks`
 * subpath) that the registry service consumes (SPEC §8).
 */
export { run, buildProgram } from './cli.js';
export type { IO } from './io.js';
export * from './checks/index.js';
