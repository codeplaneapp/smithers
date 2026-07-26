// Build the local Smithers UI (`apps/smithers`) and stage its bundle at
// `apps/cli/ui-dist` so the published CLI can serve `smithers ui --app` with no
// source tree, no vite, and no build step on the user's machine.
//
// Runs as apps/cli's `prepack`, so it fires on `pnpm publish`/`pnpm pack` only —
// never on a plain `pnpm -r build` or the test gate. `ui-dist/` is gitignored
// but listed in package.json `files`, so npm packs it even though git ignores it.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = resolve(cliDir, "..", "smithers");
const outDir = join(cliDir, "ui-dist");

if (!existsSync(join(appDir, "package.json"))) {
  // Source app absent (e.g. a slimmed checkout). Nothing to bundle; leave any
  // existing ui-dist in place so this stays a no-op rather than a failure.
  console.log(`[build-ui] ${appDir} not found — skipping UI bundle`);
  process.exit(0);
}

const viteBin = join(appDir, "node_modules", ".bin", "vite");
if (!existsSync(viteBin)) {
  console.error(`[build-ui] vite is not installed in ${appDir}. Run \`pnpm install\` before packing the CLI.`);
  process.exit(1);
}

console.log("[build-ui] building the local Smithers UI (vite build)…");
const build = spawnSync(viteBin, ["build"], { cwd: appDir, stdio: "inherit" });
if (build.status !== 0) {
  console.error("[build-ui] vite build failed");
  process.exit(build.status ?? 1);
}

const builtDist = join(appDir, "dist");
if (!existsSync(join(builtDist, "index.html"))) {
  console.error(`[build-ui] expected ${join(builtDist, "index.html")} after build`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
cpSync(builtDist, outDir, { recursive: true });
console.log(`[build-ui] staged UI bundle at ${outDir}`);

// Bundle the concierge chat backend (server.ts + its @tanstack/ai deps) into a
// single file so the published CLI can run it. It uses Bun.serve, so the runtime
// still needs `bun` on PATH — the CLI checks for that before spawning it.
const conciergeEntry = join(appDir, "concierge", "server.ts");
if (existsSync(conciergeEntry)) {
  console.log("[build-ui] bundling the concierge chat backend…");
  const bundle = spawnSync(
    "bun",
    ["build", conciergeEntry, "--target=bun", "--outfile", join(outDir, "concierge.js")],
    { cwd: appDir, stdio: "inherit" },
  );
  if (bundle.status !== 0) {
    console.error("[build-ui] concierge bundle failed");
    process.exit(bundle.status ?? 1);
  }
  console.log(`[build-ui] staged concierge at ${join(outDir, "concierge.js")}`);
} else {
  console.log("[build-ui] no concierge source — skipping chat backend bundle");
}
