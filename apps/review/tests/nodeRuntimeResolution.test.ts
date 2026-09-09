import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { renderWalkthroughHtml } from "../src/walkthrough/renderWalkthroughHtml.ts";

/**
 * The review runs under Node, so every module it reaches must resolve there.
 *
 * `bin/smithers-review.mjs` is a Node entry point and the workspace ships
 * TypeScript sources, so Node strips the types and then applies its own ESM
 * resolution: a relative specifier without a file extension throws
 * `ERR_MODULE_NOT_FOUND`. Bun resolves the same specifier, so the rest of this
 * suite, which runs under Bun, cannot see the difference. That is the whole
 * reason this file spawns Node.
 *
 * The modules below are the ones that leave `apps/review` for a workspace
 * package: both import `@smthrs/ui-styleguide`, whose own relative imports have
 * to carry `.ts` for Node to find them. A dependency that drops an extension
 * fails here instead of at the first real review.
 */
const entryPoints = [
  "../src/walkthrough/walkthroughCss.ts",
  "../src/server/landingPage.ts",
  "../src/cli/runReview.ts",
] as const;

describe("the Node runtime resolves every module the review loads", () => {
  for (const entry of entryPoints) {
    test(`node imports ${entry.replace("../src/", "src/")}`, () => {
      const target = fileURLToPath(new URL(entry, import.meta.url));
      const result = spawnSync(
        "node",
        ["--input-type=module", "-e", `await import(${JSON.stringify(target)});`],
        { encoding: "utf8", env: process.env },
      );
      // The message matters as much as the status: ERR_MODULE_NOT_FOUND names
      // the specifier that failed, which is the fix.
      expect(`${result.stderr}`).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.status).toBe(0);
    }, 60_000);
  }
});

describe("walkthrough diagrams under Node ESM", () => {
  for (const hasDiagram of [true, false]) {
    test(`renders a story ${hasDiagram ? "with" : "without"} a Mermaid runtime`, () => {
      const input: Parameters<typeof renderWalkthroughHtml>[0] = {
        title: "Node walkthrough",
        story: {
          headline: "A narrated change",
          synopsis: "A small story.",
          chapters: [
            {
              title: "The flow",
              blocks: [
                {
                  kind: hasDiagram ? "diagram" : "prose",
                  text: "A becomes B.",
                  path: "",
                  intro: "",
                  title: "The diagram",
                  mermaid: hasDiagram ? "graph TD; A-->B" : "",
                },
              ],
            },
          ],
        },
        files: [],
        comments: [],
        repoDir: "/tmp/repo",
        mode: "workspace",
        ref: "workspace",
        generatedAt: "2026-06-10T00:00:00.000Z",
      };
      const renderer = new URL("../src/walkthrough/renderWalkthroughHtml.ts", import.meta.url).href;
      const runtime = new URL("../src/walkthrough/mermaidRuntimeGzipBase64.ts", import.meta.url).href;
      const result = spawnSync(
        "node",
        ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import fs from "node:fs";
        import { createRequire, syncBuiltinESMExports } from "node:module";
        import { gunzipSync } from "node:zlib";

        const readFileSync = fs.readFileSync;
        let runtimeReads = 0;
        fs.readFileSync = function (path, ...args) {
          if (String(path).endsWith("mermaid.min.js")) runtimeReads++;
          return readFileSync.call(this, path, ...args);
        };
        syncBuiltinESMExports();

        const { renderWalkthroughHtml } = await import(${JSON.stringify(renderer)});
        const html = await renderWalkthroughHtml(${JSON.stringify(input)});
        assert.ok(html.startsWith("<!doctype html>"));
        if (${hasDiagram}) {
          const { mermaidRuntimeGzipBase64 } = await import(${JSON.stringify(runtime)});
          const encoded = mermaidRuntimeGzipBase64();
          assert.ok(encoded.length > 0);
          assert.ok(html.includes('<script type="text/plain" id="mermaid-runtime-gz">' + encoded + '</script>'));
          assert.ok(html.includes('<pre class="mermaid">graph TD; A--&gt;B</pre>'));
          assert.ok(html.includes("mermaid.initialize"));
          assert.equal(runtimeReads, 1, "the runtime is read once and cached");
          const source = readFileSync(createRequire(${JSON.stringify(runtime)}).resolve("mermaid/dist/mermaid.min.js"));
          assert.deepEqual(gunzipSync(Buffer.from(encoded, "base64")), source);
        } else {
          assert.ok(html.includes("A becomes B."));
          assert.ok(!html.includes('id="mermaid-runtime-gz"'));
          assert.ok(!html.includes("mermaid.initialize"));
          assert.equal(runtimeReads, 0, "plain stories must not load the runtime");
        }
        `],
        { encoding: "utf8", env: process.env, timeout: 60_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }, 65_000);
  }
});
