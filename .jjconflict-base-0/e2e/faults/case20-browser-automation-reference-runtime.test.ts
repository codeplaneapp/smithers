import { afterAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const chromiumExecutable = chromium.executablePath();
const hasChromium = existsSync(chromiumExecutable);
const workspaces: string[] = [];

type BrowserRuntimeProof = {
  result: { status: string; output?: { answer?: number } };
  stored: { status: string };
  outputs: {
    agent_output: Array<{ answer: number }>;
    dependent_output: Array<{ answer: number }>;
  };
  generateCalls: number;
  globals: { process: string; Bun: string; Buffer: string };
  capabilityProof: {
    worktree: { runtime: string; capability: string; operation: string };
  };
};

afterAll(async () => {
  await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe.skipIf(!hasChromium)("case 20: Browser automation task in reference runtime", () => {
  test(
    "provisions Chromium and executes the production browser runtime inside a workspace",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "smithers-case20-browser-workspace-"));
      workspaces.push(workspace);
      const bundlePath = join(workspace, "runtime-task.js");

      // Bundle the same public browser entry and production runtime path that a
      // consumer runs. The bundle and page both live in this isolated workspace.
      const result = await build({
        entryPoints: [resolve(import.meta.dir, "../browser/fixture.js")],
        outfile: bundlePath,
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        metafile: true,
      });
      const bundle = await readFile(bundlePath);

      const server = createServer((request, response) => {
        if (request.url === "/runtime-task.js") {
          response.writeHead(200, { "content-type": "text/javascript" });
          response.end(bundle);
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<!doctype html><script type="module" src="/runtime-task.js"></script>');
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", resolveListen);
      });

      const address = server.address();
      if (!address || typeof address === "string") throw new Error("browser workspace server did not bind a TCP port");

      const browser = await chromium.launch({ executablePath: chromiumExecutable, headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}/`);
        await page.waitForFunction(() => Boolean(globalThis.__smithersBrowserResult), undefined, { timeout: 15_000 });
        const proof = await page.evaluate<BrowserRuntimeProof>(() => globalThis.__smithersBrowserResult);

        expect(proof.result).toMatchObject({ status: "finished", output: { answer: 43 } });
        expect(proof.stored.status).toBe("finished");
        expect(proof.outputs.agent_output[0].answer).toBe(42);
        expect(proof.outputs.dependent_output[0].answer).toBe(43);
        expect(proof.generateCalls).toBe(1);
        expect(proof.globals).toEqual({ process: "undefined", Bun: "undefined", Buffer: "undefined" });
        expect(proof.capabilityProof.worktree).toMatchObject({
          runtime: "browser",
          capability: "worktree",
          operation: "resolve",
        });
        expect(Object.keys(result.metafile.inputs).length).toBeGreaterThan(0);
      } finally {
        await browser.close();
        await new Promise<void>((resolveClose, rejectClose) =>
          server.close((error) => (error ? rejectClose(error) : resolveClose())),
        );
      }
    },
    30_000,
  );
});

declare global {
  // Set by e2e/browser/fixture.js after the production browser runtime finishes.
  var __smithersBrowserResult: BrowserRuntimeProof;
}
