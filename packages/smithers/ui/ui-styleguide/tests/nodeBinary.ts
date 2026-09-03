/**
 * The Node executable to spawn, from a suite Bun runs.
 *
 * `process.execPath` is the runtime executing the suite, and this package's
 * only runner is `bun test tests`, so it is `bun`. A child spawned from it is
 * another Bun, which resolves extensionless TypeScript specifiers and would
 * therefore pass the very Node ESM check `tests/nodeEsmResolution.test.ts`
 * exists to perform. Under Node, `process.versions.bun` is `undefined` and
 * `process.execPath` is already the right binary.
 *
 * Callers must still prove the child is Node rather than trusting this
 * constant: both spawning suites probe `process.versions.bun` in the child
 * before they assert anything else.
 */
export const nodeExecutable: string = process.versions.bun === undefined ? process.execPath : "node";
