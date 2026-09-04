/**
 * TypeScript's `./foo.js` -> `foo.ts` extension table, owned once.
 *
 * The mapping is the compiler's, in the compiler's probe order. tsx applies
 * it on the ES-module path; the CommonJS bridge in `effect-resolution.js`
 * applies this table so a bridged declaration module resolves the same
 * files; and the syntax resolver in `Resolver.ts` probes it so the import
 * closure agrees with both. One definition keeps the three from drifting.
 *
 * The module is plain JavaScript because `effect-resolution.js` is imported
 * by `main.js` under plain Node, before any TypeScript loader is registered,
 * so nothing on that path may import a `.ts` file. The `.d.ts` sibling types
 * it for the TypeScript importers.
 *
 * @since 0.1.0
 */

/**
 * TypeScript's `./foo.js` -> `foo.ts` mapping, in the compiler's probe order.
 *
 * @category constants
 * @since 0.1.0
 */
export const jsExtensionSiblings = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"]
}
