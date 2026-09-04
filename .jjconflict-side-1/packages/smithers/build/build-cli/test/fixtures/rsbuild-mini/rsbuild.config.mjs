// A deliberately dependency-free rsbuild config: a plain object export, so
// the fixture needs no imports beyond the node_modules tree the test links
// in. One web environment, one TS entry, hashed filenames off for stable
// assertions.
export default {
  environments: {
    web: {
      source: { entry: { index: "./src/main.ts" } },
      output: { target: "web", distPath: { root: "dist" } }
    }
  },
  output: { filenameHash: false, sourceMap: false }
}
