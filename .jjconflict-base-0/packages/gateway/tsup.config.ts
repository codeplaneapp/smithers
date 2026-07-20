import { build, defineConfig, type Options } from "tsup";

// One config per public subpath so each entry gets its own self-contained
// declaration bundle (a single multi-entry config splits shared types into
// generated chunk files inside src/). Run them serially: parallel configs race
// with their own emitted `.d.ts` files during module resolution, which changes
// the root declaration bundle from build to build.
const declarationEntry = (name: string, source: string): Options => ({
  entry: { [name]: source },
  dts: { only: true, resolve: false },
  outDir: "src",
  format: ["esm"],
  silent: true,
});

const declarationEntries = [
  declarationEntry("index", "src/index.js"),
  declarationEntry("rpc/index", "src/rpc/index.js"),
  declarationEntry("auth/scopes", "src/auth/scopes.js"),
  declarationEntry("api/index", "src/api/index.js"),
];

export default defineConfig(async () => {
  for (const entry of declarationEntries.slice(0, -1)) {
    await build({ ...entry, config: false });
  }
  return declarationEntries.at(-1)!;
});
