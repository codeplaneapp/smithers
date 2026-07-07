import { defineConfig } from "tsup";

// One config per public subpath so each entry gets its own self-contained
// declaration bundle (a single multi-entry config would split shared types
// into generated chunk files inside src/). Stale declarations are pruned by
// `clean-dts.mjs` in the build script BEFORE tsup runs — NOT via per-config
// `clean`: tsup executes the four configs concurrently against the shared
// `src` outDir, and the in-config clean raced the sibling emits, so the build
// nondeterministically exited 0 with `index.d.ts`/`rpc/index.d.ts` missing
// (reproduced 2-in-8 locally; downstream symptom = gateway-react's dts build
// failing TS7016 on `@smithers-orchestrator/gateway/rpc` in CI).
const declarationEntry = (name: string, source: string) => ({
  entry: { [name]: source },
  dts: { only: true as const, resolve: false },
  outDir: "src",
  format: ["esm" as const],
  silent: true,
});

export default defineConfig([
  declarationEntry("index", "src/index.js"),
  declarationEntry("rpc/index", "src/rpc/index.js"),
  declarationEntry("auth/scopes", "src/auth/scopes.js"),
  declarationEntry("api/index", "src/api/index.js"),
]);
