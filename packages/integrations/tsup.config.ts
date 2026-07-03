import { defineConfig } from "tsup";

export default defineConfig({
  // One declaration bundle per public entry: the core barrel plus each service
  // subpath, so `@smithers-orchestrator/integrations/<service>` ships real types
  // (the package.json exports map points each subpath at its own .d.ts). The
  // type twins are named `<name>Types.ts` so they never collide with the
  // same-basename runtime `.js` in declaration output.
  entry: {
    index: "src/index.js",
    telegram: "src/telegram.js",
    github: "src/github.js",
    linear: "src/linear.js",
  },
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
  format: ["esm"],
  silent: true,
});
