import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The package's central architectural rule, stated in README.md and
 * src/README.md: heavy third-party renderers live under `adapters/` behind
 * their own package subpath and never weigh down the base barrel.
 *
 * Nothing enforced it. `scripts/check-ui-architecture.mjs`, the script both
 * READMEs named, was deleted in the 1.0 migration (disposition-ledger row
 * `scripts/check-ui-architecture.mjs`, disposition `delete`), and by the time
 * this ratchet was written `export * from "./vault"` was pulling `d3-force`
 * into `@smthrs/ui` through `KnowledgeGraph`.
 *
 * This is the replacement, and it measures the thing the rule is about: what a
 * bundler actually emits for a consumer. The build is deliberately
 * non-splitting, which is the mode this package is consumed in.
 */
const HEAVY_MODULES = [
  "node_modules/recharts",
  "node_modules/@xterm",
  "node_modules/@milkdown",
  "node_modules/@pierre/diffs",
  "node_modules/d3-force",
] as const;

/**
 * Bundle a module the way a consumer reaches it: through an entry that imports
 * the namespace and retains it.
 *
 * Handing `Bun.build` a re-export-only barrel directly is not a measurement. It
 * emits the export list with no bodies at all (7 KB, zero functions), because
 * nothing in the graph is retained, so every "is X absent" assertion would pass
 * against an empty bundle. A consuming entry is the honest shape: this one
 * builds to about 1 MB with ~900 functions.
 */
async function bundleAsConsumed(modulePath: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "smithers-ui-barrel-"));
  try {
    const entry = join(dir, "entry.ts");
    const target = resolve(import.meta.dir, "..", modulePath);
    writeFileSync(
      entry,
      `import * as surface from ${JSON.stringify(target)};\n(globalThis as Record<string, unknown>).__surface = surface;\n`,
    );
    const built = await Bun.build({ entrypoints: [entry], target: "browser" });
    if (!built.success) throw new AggregateError(built.logs, `could not bundle ${modulePath}`);
    const outputs = await Promise.all(built.outputs.map((artifact) => artifact.text()));
    return outputs.join("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the base barrel carries no heavy renderer", () => {
  test("a consumer of src/index.ts bundles none of the adapter dependencies", async () => {
    const bundle = await bundleAsConsumed("src/index.ts");
    // Guard the guard: an empty bundle would satisfy every assertion below.
    expect(bundle.length).toBeGreaterThan(200_000);
    expect(HEAVY_MODULES.filter((module) => bundle.includes(module))).toEqual([]);
  }, 120_000);

  test("every heavy renderer is reachable through its own subpath", async () => {
    const manifest = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.exports)).toEqual(
      expect.arrayContaining([
        "./adapters/chart",
        "./adapters/knowledge-graph",
        "./adapters/markdown-editor",
        "./adapters/pierre-diff-view",
        "./adapters/terminal",
      ]),
    );
  });

  test("the knowledge-graph subpath does bundle d3-force", async () => {
    // The control: the negative assertion above only means something while the
    // dependency is genuinely reachable from somewhere in this package.
    const bundle = await bundleAsConsumed("src/adapters/knowledge-graph.ts");
    expect(bundle).toContain("node_modules/d3-force");
  }, 120_000);
});
