import { build, defineConfig, type Options } from "tsup";

const declarationEntry = (name: string, source: string): Options => ({
  entry: { [name]: source },
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
  format: ["esm"],
  silent: true,
});

// Build one entry at a time so each public subpath gets a deterministic,
// self-contained declaration instead of a nondeterministic shared hash chunk.
const declarationEntries = [
  declarationEntry("index", "src/index.js"),
  declarationEntry("metrics/index", "src/metrics/index.js"),
];

export default defineConfig(async () => {
  for (const entry of declarationEntries.slice(0, -1)) {
    await build({ ...entry, config: false });
  }
  return declarationEntries.at(-1)!;
});
