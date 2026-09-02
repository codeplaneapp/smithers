import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const srcDir = join(import.meta.dir, "..", "src");
const PRAGMA = "/** @jsxImportSource react */";
const files = readdirSync(srcDir, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();

test("finds .tsx source files to check", () => {
  expect(files.length).toBeGreaterThanOrEqual(80);
});

describe("jsx-runtime pragma", () => {
  for (const file of files) {
    test(`${relative(srcDir, file)} declares the React JSX runtime pragma on line 1`, () => {
      const firstLine = readFileSync(file, "utf8").split("\n", 1)[0];
      expect(firstLine).toBe(PRAGMA);
    });
  }
});
