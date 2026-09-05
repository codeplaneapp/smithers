/**
 * TypeScript's `./foo.js` -> `foo.ts` extension table, owned once.
 *
 * The mapping is the compiler's, in the compiler's probe order. The syntax
 * resolver in `Resolver.ts` probes these siblings when finding a declaration's
 * import closure. Runtime extension handling belongs to tsx's supported ESM
 * and CommonJS loaders. The `.d.ts` sibling types this table for TypeScript
 * importers.
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
