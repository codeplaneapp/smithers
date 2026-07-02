import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { createSmithersCollections } from "../../src/data/createSmithersCollections.ts";

const forbiddenPackages = ["@tanstack/electric-db-collection", "@electric-sql/client"];

describe("local WorkspaceMode import boundary", () => {
  test("local collections never load Electric packages", () => {
    const originalRequire = (globalThis as typeof globalThis & { require?: (id: string) => unknown }).require;
    const attempted: string[] = [];
    (globalThis as typeof globalThis & { require?: (id: string) => unknown }).require = ((id: string) => {
      if (forbiddenPackages.some((pkg) => id === pkg || id.startsWith(`${pkg}/`))) {
        attempted.push(id);
        throw new Error(`forbidden local import: ${id}`);
      }
      if (!originalRequire) throw new Error(`unexpected require without original loader: ${id}`);
      return originalRequire(id);
    }) as typeof originalRequire;

    const queryClient = new QueryClient();
    try {
      const collections = createSmithersCollections(
        { kind: "local", apiBaseUrl: "http://127.0.0.1:1", token: "local-token" },
        queryClient,
      );
      expect(collections.client.mode.kind).toBe("local");
      expect(attempted).toEqual([]);
      collections.close();
    } finally {
      queryClient.clear();
      (globalThis as typeof globalThis & { require?: (id: string) => unknown }).require = originalRequire;
    }
  });

  test("local provider entrypoint has no static Electric package import", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/data/createSmithersCollections.ts"),
      "utf8",
    );
    for (const pkg of forbiddenPackages) expect(source).not.toContain(pkg);
  });
});
