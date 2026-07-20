import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { mdxPlugin } from "../src/mdx-plugin.js";
import { createExternalSmithers } from "../src/external/index.js";

const tempDirs = [];
const testDir = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mdxPlugin", () => {
  test("registers the public Bun MDX loader for real .mdx imports", async () => {
    const dir = mkdtempSync(join(testDir, ".mdx-plugin-"));
    tempDirs.push(dir);
    const mdxPath = join(dir, "fixture.mdx");
    writeFileSync(
      mdxPath,
      [
        'export const title = "Smithers MDX";',
        "",
        "# {title}",
        "",
        "Loaded through the public mdxPlugin.",
      ].join("\n"),
    );

    mdxPlugin();

    const mod = await import(`${pathToFileURL(mdxPath).href}?t=${Date.now()}`);
    expect(mod.title).toBe("Smithers MDX");
    expect(typeof mod.default).toBe("function");
  });
});

describe("external public facade", () => {
  test("exports createExternalSmithers from the package-level external entrypoint", () => {
    expect(typeof createExternalSmithers).toBe("function");
  });
});
