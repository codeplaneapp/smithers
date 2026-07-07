import { defineConfig } from "tsup";

// One config per public subpath so each entry gets its own self-contained
// declaration bundle (a single multi-entry config would split shared types
// into generated chunk files inside src/). `clean` removes the previous
// declaration before regenerating: without it the dts rollup resolves the
// stale on-disk `.d.ts` for the entry and silently re-emits it unchanged.
// Glob is relative to `outDir` (`src`), so only the generated declaration is
// cleaned; `.js`/`.ts` sources are untouched.
const declarationEntry = (name: string, source: string) => ({
  entry: { [name]: source },
  dts: { only: true as const, resolve: false },
  outDir: "src",
  clean: [`${name}.d.ts`],
  format: ["esm" as const],
  silent: true,
});

export default defineConfig([
  declarationEntry("index", "src/index.js"),
  declarationEntry("rpc/index", "src/rpc/index.js"),
  declarationEntry("auth/scopes", "src/auth/scopes.js"),
  declarationEntry("api/index", "src/api/index.js"),
]);
