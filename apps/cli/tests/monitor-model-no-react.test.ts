/**
 * monitorModel.ts calls itself framework-free; this pins that it actually is
 * (issue #1381).
 *
 * It used to read its status vocabulary from `smthrs/ui`, and
 * that barrel eagerly evaluates dialog/select/tooltip -> radix-ui ->
 * react-remove-scroll. There is no runtime tree-shaking, so two pure helpers
 * pulled the whole React component tree into every plain CLI test process that
 * imports the model -- which is what exposed bun 1.3.13's dual CJS/ESM loader
 * race ("Requested module is already fetched") on the shared shard.
 *
 * The graph assertion runs in a child process because `bun test` itself loads
 * React for the DOM suites; only a fresh process can prove the model does not.
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_SOURCE = resolve(CLI_ROOT, "src/monitor-ui/monitorModel.ts");

// react-remove-scroll is the module that actually crashed; react/scheduler are
// the roots it races on, and radix-ui is the barrel edge that pulls them in.
const REACT_FAMILY = /[/\\](react|react-dom|radix-ui|react-remove-scroll|scheduler)[/\\]/;

test("monitorModel imports the status vocabulary from the React-free subpath", () => {
  const source = readFileSync(MODEL_SOURCE, "utf8");
  expect(source).toContain('from "smthrs/ui/status"');
  expect(source).not.toMatch(/from "smthrs\/ui"/);
});

test("the status subpath exports the vocabulary monitorModel needs", async () => {
  const status = await import("smthrs/ui/status");
  expect(typeof status.normalizeStatus).toBe("function");
  expect(typeof status.statusClass).toBe("function");
  expect(status.statusClass("waiting-approval")).toBe("warn");
  expect(status.normalizeStatus(" WAITING_APPROVAL ")).toBe("waiting-approval");
});

test("importing monitorModel loads no React, radix, or react-remove-scroll module", () => {
  const probe =
    `await import("./src/monitor-ui/monitorModel.ts");` +
    `console.log(JSON.stringify(Object.keys(require.cache).filter((path) => ${REACT_FAMILY}.test(path))));`;
  const result = spawnSync(process.execPath, ["-e", probe], { cwd: CLI_ROOT, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual([]);
});

test("the shared CLI runner bounds mixed React test process state", () => {
  const packageJson = JSON.parse(readFileSync(resolve(CLI_ROOT, "package.json"), "utf8")) as {
    scripts: { test: string };
  };
  const [isolated, shared] = packageJson.scripts.test.split(" && ");
  expect(isolated).toContain("tests/monitor-shell-controls.test.tsx");
  expect(isolated).not.toContain("--preload");
  expect(shared).toBe("bun ./scripts/run-test-shards.mjs");

  const runner = readFileSync(resolve(CLI_ROOT, "scripts/run-test-shards.mjs"), "utf8");
  expect(runner).toContain('"--isolate"');
  expect(runner).not.toContain('"--preload"');
  expect(runner).toContain('new Set(["monitor-shell-controls.test.tsx"])');
  expect(runner).toContain("const BATCH_SIZE = 1");
  const bunfig = readFileSync(resolve(CLI_ROOT, "bunfig.toml"), "utf8");
  expect(bunfig).toContain("[test]");
  expect(bunfig).toContain('preload = ["./tests/preload-ui-chain.ts"]');
});
