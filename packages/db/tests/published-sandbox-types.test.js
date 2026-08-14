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

describe("published cancellation attribution declarations", () => {
  test("include run fields, adapter parameters, and schema columns", () => {
    const declarations = readFileSync(declarationPath, "utf8");

    for (const field of [
      "cancelRequestId: string | null;",
      "cancelRequestSource: string | null;",
      "cancelRequestDetail: string | null;",
      "cancelRequestSignal: string | null;",
      "cancelRequestClientIdentity: string | null;",
      "cancelRequestClientPid: number | null;",
    ]) {
      expect(declarations).toContain(field);
    }

    expect(declarations).toMatch(/requestRunCancel\([^;]+attribution\?: \{/s);
    expect(declarations).toMatch(/claimRunCancellation\([^;]+attribution\?: \{/s);

    for (const column of [
      'name: "cancel_request_id";',
      'name: "cancel_request_source";',
      'name: "cancel_request_detail";',
      'name: "cancel_request_signal";',
      'name: "cancel_request_client_identity";',
      'name: "cancel_request_client_pid";',
    ]) {
      expect(declarations).toContain(column);
    }
  });
});
