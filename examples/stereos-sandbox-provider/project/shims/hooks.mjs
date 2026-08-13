// Resolver hooks that let the published smthrs run under Node.
//
// smthrs ships Bun-only modules behind runtime guards. Node's ESM loader still
// has to resolve the specifiers even when the guarded code never executes, and
// it rejects the whole `bun:` URL scheme before any guard runs. Map every such
// specifier to a stub. Under SMITHERS_BACKEND=pglite none of the stubs are
// constructed; each throws a clear error if that ever changes.
const EXACT = new Map([
  ["bun", new URL("./bun.mjs", import.meta.url).href],
  ["bun:sqlite", new URL("./bun-sqlite.mjs", import.meta.url).href],
  ["bun:test", new URL("./bun-test.mjs", import.meta.url).href],
  ["drizzle-orm/bun-sqlite", new URL("./drizzle-bun-sqlite.mjs", import.meta.url).href],
]);
const BUN_SCHEME_FALLBACK = new URL("./bun.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const mapped = EXACT.get(specifier);
  if (mapped) {
    return { url: mapped, shortCircuit: true };
  }
  if (specifier.startsWith("bun:")) {
    return { url: BUN_SCHEME_FALLBACK, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

// tsx resolves some specifiers to a `bun:` URL without re-entering resolve, so
// catch the scheme at load time as well.
export async function load(url, context, nextLoad) {
  if (url.startsWith("bun:")) {
    return nextLoad(EXACT.get(url) ?? BUN_SCHEME_FALLBACK, context);
  }
  return nextLoad(url, context);
}
