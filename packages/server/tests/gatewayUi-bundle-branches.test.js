import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleGatewayUiEntry } from "../src/gatewayUi/bundle.js";

describe("gateway UI bundle branch coverage", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  test("returns the cached bundle on a second call with the same cache + entry", async () => {
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-ui-cache-"));
    const entry = join(tempDir, "entry.tsx");
    writeFileSync(entry, "console.log('cache-me');\n");
    const cache = new Map();
    const first = await bundleGatewayUiEntry({ entry }, cache);
    expect(cache.has(String(entry))).toBe(true);
    // Poison the cache value so a genuine second build would not match; the
    // cache-hit branch must return this sentinel unchanged.
    cache.set(String(entry), "CACHED_SENTINEL");
    const second = await bundleGatewayUiEntry({ entry }, cache);
    expect(second).toBe("CACHED_SENTINEL");
    expect(first).toContain("cache-me");
  });

  test("SMITHERS_GATEWAY_UI_NO_CACHE rebuilds and never populates the cache", async () => {
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-ui-nocache-"));
    const entry = join(tempDir, "entry.tsx");
    writeFileSync(entry, "console.log('no-cache');\n");
    writeFileSync(entry, "console.log(process.env.NODE_ENV);\n");
    const saved = process.env.SMITHERS_GATEWAY_UI_NO_CACHE;
    try {
      process.env.SMITHERS_GATEWAY_UI_NO_CACHE = "1";
      const cache = new Map();
      const body = await bundleGatewayUiEntry({ entry }, cache);
      // dev mode builds development React and does not cache.
      expect(cache.size).toBe(0);
      expect(body).toContain('console.log("development")');
    } finally {
      if (saved === undefined) delete process.env.SMITHERS_GATEWAY_UI_NO_CACHE;
      else process.env.SMITHERS_GATEWAY_UI_NO_CACHE = saved;
    }
  });

  test("resolves a @tanstack workspace dependency through the dedupe plugin", async () => {
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-ui-tanstack-"));
    const entry = join(tempDir, "entry.tsx");
    writeFileSync(
      entry,
      ['import { QueryClient } from "@tanstack/react-query";', "console.log(QueryClient);", ""].join("\n"),
    );
    const body = await bundleGatewayUiEntry({ entry }, new Map());
    expect(body).toContain("QueryClient");
  });

  test("resolves a smithers-orchestrator gateway UI dependency through the dedupe plugin", async () => {
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-ui-smithers-dep-"));
    const entry = join(tempDir, "entry.tsx");
    writeFileSync(
      entry,
      ['import * as GatewayClient from "@smithers-orchestrator/gateway-client";', "console.log(GatewayClient);", ""].join("\n"),
    );
    const body = await bundleGatewayUiEntry({ entry }, new Map());
    expect(body.length).toBeGreaterThan(0);
  });

  test("resolves curated rich-UI dependencies outside a consumer node_modules tree", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "smithers-ui-packaged-deps-"));
    const entry = join(tempDir, "entry.tsx");
    writeFileSync(
      entry,
      [
        'import mermaid from "mermaid";',
        'import { Crepe } from "@milkdown/crepe";',
        "console.log(mermaid, Crepe);",
        "",
      ].join("\n"),
    );
    const body = await bundleGatewayUiEntry({ entry }, new Map());
    expect(body.length).toBeGreaterThan(100_000);
    expect(body.length).toBeLessThan(10_000_000);
  });

  test("throws INVALID_INPUT when react/tanstack/smithers peers cannot resolve (build failure)", async () => {
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-ui-badpeers-"));
    const entry = join(tempDir, "entry.tsx");
    // Each import matches one dedupe regex; each resolver hits its catch and
    // returns null, then esbuild's default resolver also fails -> build error.
    writeFileSync(
      entry,
      [
        'import "react/__nope_subpath__";',
        'import "@tanstack/__nope_pkg__";',
        'import "@smithers-orchestrator/gateway/__nope__";',
        "",
      ].join("\n"),
    );
    await expect(bundleGatewayUiEntry({ entry }, new Map())).rejects.toThrow();
  });

  test("throws INVALID_INPUT for a plain unresolvable bare import", async () => {
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-ui-badentry-"));
    const entry = join(tempDir, "entry.tsx");
    writeFileSync(entry, 'import "totally-nonexistent-package-zzz";\n');
    await expect(bundleGatewayUiEntry({ entry }, new Map())).rejects.toThrow();
  });

  test("moduleSpecifier resolves unresolvable inline-component sources to a build error", async () => {
    // Inline component entries synchronously run renderComponentInlineUiEntry ->
    // moduleSpecifier BEFORE Bun.build, so a build failure still exercises the
    // moduleSpecifier branch. file://, absolute path and bare specifiers all
    // fail to resolve -> the build rejects.
    const unresolvableSources = [
      "file:///no/such/inline-ui.jsx", // file:// -> fileURLToPath branch
      join(process.cwd(), "no", "such", "inline-ui.jsx"), // absolute path branch
      "bare-inline-ui-module-zzz", // bare relative/module branch
    ];
    for (const source of unresolvableSources) {
      await expect(
        bundleGatewayUiEntry({ inline: { kind: "component", source, exportName: "default" } }, new Map()),
      ).rejects.toThrow();
    }
  });

  test("moduleSpecifier passes a protocol (data:) inline-component source through unchanged", async () => {
    // A data: URI matches the protocol branch of moduleSpecifier and is bundled
    // inline by esbuild, so the build succeeds.
    const body = await bundleGatewayUiEntry(
      {
        inline: {
          kind: "component",
          source: "data:text/javascript,export default function(){return null}",
          exportName: "default",
        },
      },
      new Map(),
    );
    expect(body).toContain("createRoot");
  });

  test("bundles a literal inline UI entry", async () => {
    const tree = { type: "main", props: { id: "root-main" }, children: ["Inline Literal"] };
    const body = await bundleGatewayUiEntry({ inline: { kind: "literal", tree } }, new Map());
    expect(body).toContain("Inline Literal");
    expect(body).toContain("createRoot");
  });
});
