import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

describe("Pi package manifest", () => {
  test("declares the published extension entry point", () => {
    const packageRoot = resolve(import.meta.dir, "..");
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    ) as {
      files?: string[];
      pi?: { extensions?: string[] };
    };

    expect(manifest.pi?.extensions).toEqual(["./src/extension.ts"]);
    expect(manifest.files).toContain("src/");
    expect(existsSync(resolve(packageRoot, "src/extension.ts"))).toBe(true);
  });
});
