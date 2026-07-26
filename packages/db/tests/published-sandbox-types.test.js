import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const adapterSourcePath = fileURLToPath(new URL("../src/adapter.js", import.meta.url));
const declarationPath = fileURLToPath(new URL("../src/index.d.ts", import.meta.url));

// Keep this list deliberately small and focused on the published sandbox
// heartbeat surface. Any new method added here must also be added to the
// committed declaration before it can ship.
const PINNED_SANDBOX_METHODS = ["upsertSandbox", "heartbeatSandbox", "getSandbox", "listSandboxes"];

describe("published SmithersDb sandbox declarations", () => {
  test("publish every pinned sandbox adapter method", () => {
    const adapterSource = readFileSync(adapterSourcePath, "utf8");
    const declarations = readFileSync(declarationPath, "utf8");
    // Match any leading indent: what is pinned here is that the method is
    // declared at all, not the width the formatter happens to print it with.
    const declaredAt = (method) => new RegExp(`^\\s+${method}\\(`, "m");
    const runtimeMethods = PINNED_SANDBOX_METHODS.filter((method) => declaredAt(method).test(adapterSource));

    expect(runtimeMethods).toEqual(PINNED_SANDBOX_METHODS);

    const missingMethods = runtimeMethods.filter((method) => !declaredAt(method).test(declarations));
    expect(missingMethods).toEqual([]);
  });
});
