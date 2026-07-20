import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const outfile = join(process.cwd(), "browser", ".fixture.bundle.js");

// A robust, metafile-based dependency-closure proof: enumerate every module
// esbuild actually put in the bundle and fail if any of them is a Node/Bun
// built-in or a known Node-only package (CLI agents, database, subprocess).
// This is precise where a text/regex scan over the output is not — it proves
// the bundle's real input graph rather than guessing from string patterns.
const result = await build({
  entryPoints: [join(process.cwd(), "browser", "fixture.js")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  metafile: true,
  write: true,
});

const FORBIDDEN_MODULE_PREFIXES = ["node:", "bun:"];
const FORBIDDEN_PACKAGE_SUBSTRINGS = [
  "/packages/agents/",
  "/packages/db/",
  "/packages/cli/",
  "/packages/sandbox/",
  "/packages/server/",
  "/packages/gateway/",
  "node_modules/better-sqlite3",
  "node_modules/child_process",
];
const inputs = Object.keys(result.metafile.inputs);
const forbiddenInputs = inputs.filter(
  (input) =>
    FORBIDDEN_MODULE_PREFIXES.some((prefix) => input.startsWith(prefix)) ||
    FORBIDDEN_PACKAGE_SUBSTRINGS.some((needle) => input.includes(needle)),
);
if (forbiddenInputs.length > 0) {
  throw new Error(`browser bundle depends on Node/Bun-only modules:\n${forbiddenInputs.map((i) => `  - ${i}`).join("\n")}`);
}

const bundle = await readFile(outfile, "utf8");
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(bundle);
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end('<!doctype html><script type="module" src="/fixture.js"></script>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on("console", (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser:error] ${error.stack ?? error}`));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => globalThis.__smithersBrowserResult, undefined, { timeout: 15000 });
  const proof = await page.evaluate(() => globalThis.__smithersBrowserResult);

  if (proof.result.status !== "finished" || proof.stored.status !== "finished") {
    throw new Error(`browser workflow did not finish: ${JSON.stringify(proof.result)}`);
  }
  if (proof.generateCalls !== 1) {
    throw new Error(`agent was called ${proof.generateCalls} times, expected exactly 1`);
  }
  if (proof.result.output?.answer !== 43) {
    throw new Error(`unexpected final structured output: ${JSON.stringify(proof.result.output)}`);
  }
  if (proof.outputs?.agent_output?.[0]?.answer !== 42 || proof.outputs?.dependent_output?.[0]?.answer !== 43) {
    throw new Error(`per-task outputs were not durably persisted: ${JSON.stringify(proof.outputs)}`);
  }
  if (!proof.runIdLooksLikeUuid) {
    throw new Error(`runId "${proof.result.runId}" was not generated via Web Crypto UUID`);
  }
  for (const capability of ["filesystem", "subprocess", "sandbox", "worktree"]) {
    const details = proof.capabilityProof[capability];
    if (!details || details.runtime !== "browser" || details.capability !== capability) {
      throw new Error(`missing/incorrect typed RuntimeCapabilityError for ${capability}: ${JSON.stringify(details)}`);
    }
  }
  if (proof.globals.process !== "undefined" || proof.globals.Bun !== "undefined" || proof.globals.Buffer !== "undefined") {
    throw new Error(`Node/Bun globals leaked into the browser page: ${JSON.stringify(proof.globals)}`);
  }
  console.log(`browser adapter conformance passed (${inputs.length} bundled modules, no Node/Bun dependency closure)`);
} finally {
  await browser.close();
  server.close();
  await rm(outfile, { force: true });
}
