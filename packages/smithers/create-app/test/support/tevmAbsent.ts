/**
 * What `tevm` resolves to when the template's suite runs as a repository gate.
 *
 * `vitest.template.config.ts` runs `template/aomi`'s tests from this package,
 * against the workspace sources the scaffolded app would install. Every
 * specifier that suite reaches resolves that way except one: `tevm` is an
 * external dependency of the template alone, nothing in this workspace depends
 * on it, and the gate may not install one. It is reached only because
 * `TOOLS.ts` declares the chain tool source, which `routes.gen.ts` imports.
 *
 * So the gate points `tevm` and `tevm/common` here. Every export throws. The
 * suite under gate never calls a chain tool — `test/tevm.test.ts` does, and
 * that file is excluded because it needs the real client — so nothing here is
 * a stand-in for behaviour: it is a tripwire. A test that starts depending on
 * the chain tools fails on the first call with the reason, rather than passing
 * against a fake.
 */

const absent = (name: string) => (): never => {
  throw new Error(
    `tevm is not installed in this workspace, so \`${name}\` cannot run here. `
      + "The template's chain tools are covered by template/aomi/test/tevm.test.ts, "
      + "which runs in a scaffolded app rather than in this gate."
  )
}

/** @see {@link absent} */
export const createMemoryClient = absent("createMemoryClient")
/** @see {@link absent} */
export const decodeErrorResult = absent("decodeErrorResult")
/** @see {@link absent} */
export const formatEther = absent("formatEther")
/** @see {@link absent} */
export const http = absent("http")
/** @see {@link absent} */
export const parseAbi = absent("parseAbi")
/** @see {@link absent} */
export const createCommon = absent("createCommon")
/** @see {@link absent} */
export const createMockKzg = absent("createMockKzg")
/** @see {@link absent} */
export const mainnet = { id: 1, name: "mainnet" }
