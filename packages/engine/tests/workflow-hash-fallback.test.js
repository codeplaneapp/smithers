import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractWorkflowImportSpecifiers, readWorkflowGraphHash } from "../src/workflow-hash.js";

const originalTranspiler = Bun.Transpiler;

afterEach(() => {
  Bun.Transpiler = originalTranspiler;
});

describe("extractWorkflowImportSpecifiers fallback scanning", () => {
  test("falls back to regex scanning when Bun.Transpiler is unavailable", () => {
    Bun.Transpiler = undefined;
    const source = [
      'import a from "./a";',
      'import "pkg";',
      'export { b } from "./b";',
      'const c = import("./c");',
      'import "./a";',
    ].join("\n");
    expect(extractWorkflowImportSpecifiers(source, "file.ts").sort()).toEqual(["./a", "./b", "./c"]);
  });

  test("falls back to regex scanning when the transpiler rejects the source", () => {
    // A truncated import makes Bun's parser throw for the whole file; the
    // regex fallback must still recover the well-formed relative imports.
    const source = 'import a from "./a";\nimport broken from';
    expect(extractWorkflowImportSpecifiers(source, "file.js")).toEqual(["./a"]);
  });

  test("regex fallback returns no specifiers for import-free source", () => {
    Bun.Transpiler = undefined;
    expect(extractWorkflowImportSpecifiers("const x = 1;", "file.js")).toEqual([]);
  });
});

describe("readWorkflowGraphHash import cycles", () => {
  test("terminates on circular imports and hashes each module once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-hash-cycle-"));
    try {
      writeFileSync(join(dir, "a.ts"), 'import "./b";\nexport const a = 1;');
      writeFileSync(join(dir, "b.ts"), 'import "./a";\nexport const b = 1;');
      const hash = await readWorkflowGraphHash(join(dir, "a.ts"));
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      // Deterministic: rehashing the unchanged cycle yields the same digest.
      expect(await readWorkflowGraphHash(join(dir, "a.ts"))).toBe(hash);
      // The hash covers the whole cycle, so editing the imported module
      // changes it even though the entry file is untouched.
      writeFileSync(join(dir, "b.ts"), 'import "./a";\nexport const b = 2;');
      expect(await readWorkflowGraphHash(join(dir, "a.ts"))).not.toBe(hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
