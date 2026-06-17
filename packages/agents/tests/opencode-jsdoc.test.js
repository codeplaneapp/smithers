import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("OpenCodeAgent JSDoc", () => {
  test("documents the current Opus model ID", async () => {
    const source = await readFile(
      resolve(__dirname, "../src/OpenCodeAgent.ts"),
      "utf8"
    );

    expect(source).toContain("anthropic/claude-opus-4-8");
    expect(source).not.toContain("anthropic/claude-opus-4-20250514");
  });
});
