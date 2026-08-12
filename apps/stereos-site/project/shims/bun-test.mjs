// Stub for "bun:test" under Node.
//
// smthrs/sandbox re-exports createSandboxProviderContractSuite from its public
// barrel, and that module imports describe/expect/test from bun:test at module
// scope. Importing smthrs/sandbox under Node therefore fails before any
// provider code runs. These no-ops satisfy the import; calling the suite under
// Node is not supported and throws.
const unsupported = () => {
  throw new Error("bun:test is unavailable under Node; the sandbox contract suite requires Bun.");
};
export const describe = unsupported;
export const test = unsupported;
export const it = unsupported;
export const expect = unsupported;
export const beforeAll = unsupported;
export const afterAll = unsupported;
export const beforeEach = unsupported;
export const afterEach = unsupported;
export default { describe, test, it, expect, beforeAll, afterAll, beforeEach, afterEach };
