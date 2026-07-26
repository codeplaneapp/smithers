import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiCollectionNames } from "@smithers-orchestrator/gateway/api";
import { QueryClient } from "@tanstack/react-query";
import { createSmithersCollections } from "../../src/data/createSmithersCollections.ts";
import { smithersApiInvalidationPrefixes } from "../../src/data/smithersApiInvalidationPrefixes.ts";

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
    const source = readFileSync(join(import.meta.dir, "../../src/data/createSmithersCollections.ts"), "utf8");
    for (const pkg of forbiddenPackages) expect(source).not.toContain(pkg);
  });

  test("multiplayer collections load Electric without a require global", async () => {
    const originalRequire = (globalThis as typeof globalThis & { require?: (id: string) => unknown }).require;
    Reflect.deleteProperty(globalThis, "require");
    const queryClient = new QueryClient();
    try {
      const collections = await createSmithersCollections(
        {
          kind: "multiplayer",
          apiBaseUrl: "http://127.0.0.1:1",
          electricBaseUrl: "http://127.0.0.1:2",
          workspaceId: "workspace-browser-esm",
          token: "multiplayer-token",
        },
        queryClient,
      );
      const runs = collections.runs();
      expect(collections.client.mode.kind).toBe("multiplayer");
      expect(runs.id).toContain("runs");
      collections.close();
    } finally {
      queryClient.clear();
      if (originalRequire) {
        (globalThis as typeof globalThis & { require?: (id: string) => unknown }).require = originalRequire;
      } else {
        Reflect.deleteProperty(globalThis, "require");
      }
    }
  });

  test("every server API collection invalidates a targeted prefix", () => {
    const root = JSON.stringify(["smithers"]);
    for (const name of apiCollectionNames) {
      const prefixes = smithersApiInvalidationPrefixes(name);
      expect(prefixes.length).toBeGreaterThan(0);
      expect(prefixes.map((prefix) => JSON.stringify(prefix))).not.toContain(root);
    }
  });
});
