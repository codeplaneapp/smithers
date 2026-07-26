import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");
const EXAMPLES_DIR = resolve(REPO_ROOT, "examples");

// The committed examples import the AI SDK (`ai`, `@ai-sdk/anthropic`) purely to
// declare agents; those packages are deliberately NOT installed at the repo root
// (see docs-examples-smoke.test.js, which stubs them the same way). Rendering a
// workflow graph only loads the module — it never invokes an agent — so a tiny
// stub resolvable from examples/ is enough to let every example load. We write it
// into examples/node_modules (gitignored) and clean it up afterward.
const AI_STUB_PACKAGES = {
  "ai/package.json": JSON.stringify({ type: "module", exports: { ".": "./index.js" } }) + "\n",
  "ai/index.js": [
    "export class ToolLoopAgent { constructor(opts = {}) { this.opts = opts; } }",
    "export const Output = { object(value) { return value; } };",
    "export function stepCountIs() { return () => false; }",
    "export function tool(def) { return def; }",
    "",
  ].join("\n"),
  "@ai-sdk/anthropic/package.json": JSON.stringify({ type: "module", exports: { ".": "./index.js" } }) + "\n",
  "@ai-sdk/anthropic/index.js": 'export function anthropic(model) { return { provider: "anthropic", model }; }\n',
  "@ai-sdk/openai/package.json": JSON.stringify({ type: "module", exports: { ".": "./index.js" } }) + "\n",
  "@ai-sdk/openai/index.js": 'export function openai(model) { return { provider: "openai", model }; }\n',
};

function writeAiSdkStubs() {
  const created = [];
  const modulesDir = resolve(EXAMPLES_DIR, "node_modules");
  for (const [relative, contents] of Object.entries(AI_STUB_PACKAGES)) {
    const target = resolve(modulesDir, relative);
    // Never clobber a real install: only write (and later remove) stub files we own.
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
    created.push(target);
  }
  return () => {
    for (const packageDir of ["ai", "@ai-sdk"]) {
      rmSync(resolve(modulesDir, packageDir), { recursive: true, force: true });
    }
    // Only remove examples/node_modules if we created it and nothing else landed there.
    if (created.length > 0 && existsSync(modulesDir) && readdirSync(modulesDir).length === 0) {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  };
}
const GRAPH_INPUT = {
  repo: ".",
  goal: "Smoke-test the committed example workflow graph",
  prompt: "Render this example without executing agents",
  change: "demo",
  diff: "diff --git a/example b/example",
  maxIterations: 1,
};

function findTopLevelExampleWorkflows() {
  return Array.from(new Bun.Glob("examples/*.jsx").scanSync({ cwd: REPO_ROOT })).sort();
}

test("top-level example workflows render as graphs", () => {
  const examples = findTopLevelExampleWorkflows();
  expect(examples).toContain("examples/smoketest.jsx");
  expect(examples.length).toBeGreaterThan(50);

  const cleanupStubs = writeAiSdkStubs();
  try {
    for (const example of examples) {
      const result = spawnSync(
        process.execPath,
        ["run", CLI_ENTRY, "graph", example, "--input", JSON.stringify(GRAPH_INPUT), "--format", "json"],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: "sk-ant-test",
            OPENAI_API_KEY: "sk-test",
            GEMINI_API_KEY: "",
            GOOGLE_API_KEY: "",
          },
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      if (result.status !== 0) {
        throw new Error(`${example} failed:\nstdout:${result.stdout}\nstderr:${result.stderr}`);
      }

      const graph = JSON.parse(result.stdout);
      expect(graph.xml?.kind, `${example} did not render an XML graph`).toBe("element");
      expect(Array.isArray(graph.tasks), `${example} did not expose graph tasks`).toBe(true);

      const source = readFileSync(resolve(REPO_ROOT, example), "utf8");
      expect(source.length, `${example} should be a committed source file`).toBeGreaterThan(0);
    }
  } finally {
    cleanupStubs();
  }
  // 100+ examples, each a separate CLI subprocess at ~2.4s on an idle machine, so
  // the old 240s budget was exactly the serial runtime: one added example or any
  // competing load tipped it into a timeout that looked like a render failure
  // (the spawn is killed, so stdout/stderr come back empty).
}, 900_000);
