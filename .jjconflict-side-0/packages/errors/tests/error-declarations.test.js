import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { smithersErrorDefinitions } from "../src/smithersErrorDefinitions.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readDeclaredErrorCodes() {
  const declarations = readFileSync(join(packageRoot, "src/index.d.ts"), "utf8");
  const match = declarations.match(/declare namespace smithersErrorDefinitions \{([\s\S]*?)\n\}/);
  expect(match).not.toBeNull();
  return [...match[1].matchAll(/^\s{4}namespace\s+([A-Z0-9_]+)\s+\{/gm)].map((codeMatch) => codeMatch[1]);
}

describe("error declarations", () => {
  test("KnownSmithersErrorCode declaration matches the runtime catalog", () => {
    expect(readDeclaredErrorCodes().sort()).toEqual(Object.keys(smithersErrorDefinitions).sort());
  });
});
