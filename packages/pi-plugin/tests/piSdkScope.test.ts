import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const packageRoot = resolve(import.meta.dir, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : extname(path) === ".ts" ? [path] : [];
  });
}

describe("Pi SDK package scope", () => {
  test("uses Pi-provided SDK packages as wildcard peers", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

    expect(manifest.peerDependencies).toMatchObject({
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*",
    });
    expect(manifest.peerDependenciesMeta).toMatchObject({
      "@earendil-works/pi-coding-agent": { optional: true },
      "@earendil-works/pi-tui": { optional: true },
    });
    expect(manifest.devDependencies).toMatchObject({
      "@earendil-works/pi-coding-agent": "^0.81.1",
      "@earendil-works/pi-tui": "^0.81.1",
    });
    expect(manifest.dependencies).not.toHaveProperty("@mariozechner/pi-coding-agent");
    expect(manifest.dependencies).not.toHaveProperty("@mariozechner/pi-tui");
  });

  test("imports SDK APIs from the current scope", () => {
    const sourcePaths = sourceFiles(join(packageRoot, "src"));
    const sources = sourcePaths.map((path) => readFileSync(path, "utf8"));
    const combinedSource = sources.join("\n");

    expect(combinedSource).not.toContain("@mariozechner/");
    expect(readFileSync(join(packageRoot, "src/extension.ts"), "utf8"))
      .toContain('from "@earendil-works/pi-coding-agent"');
    for (const path of [
      "src/extension.ts",
      "src/views/FrameScrubber.ts",
      "src/views/Header.ts",
      "src/views/NodeInspector.ts",
      "src/views/RunInspector.ts",
      "src/views/RunTree.ts",
    ]) {
      expect(readFileSync(join(packageRoot, path), "utf8"))
        .toContain('from "@earendil-works/pi-tui"');
    }
  });

  test("uses the SDK exports directly instead of local compatibility shims", () => {
    expect(sourceFiles(join(packageRoot, "src")).map((path) => path.replace(`${packageRoot}/`, "")))
      .not.toContain("src/piSdk.d.ts");
    expect(sourceFiles(join(packageRoot, "src")).map((path) => path.replace(`${packageRoot}/`, "")))
      .not.toContain("src/piTui.ts");

    const extension = readFileSync(join(packageRoot, "src/extension.ts"), "utf8");
    expect(extension).toContain('import { Text } from "@earendil-works/pi-tui"');
    expect(extension).toContain("new Text(");
  });
});
