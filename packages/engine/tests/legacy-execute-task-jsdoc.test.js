import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("legacyExecuteTask JSDoc", () => {
  test("documents the optional trace context passed through toolConfig", async () => {
    const source = await readFile(resolve(__dirname, "../src/engine.js"), "utf8");

    expect(source).toMatch(
      /@param \{\{[^\n]*traceContext\?: \{ workflowPath: string \| null; workflowHash: string \| null; logDir\?: string; annotations\?: Record<string, string \| number \| boolean>; \}; \}\} toolConfig/,
    );
  });
});
