import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");
const EXAMPLES_DIR = resolve(REPO_ROOT, "examples");
const EXAMPLE_COPY_EXCLUDES = new Set(["node_modules", "swe-evo", "bun-port-smithers"]);

function writeFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function symlinkDir(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, "dir");
}

function createExampleProject() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-example-graphs-"));
  const examplesDir = join(dir, "examples");
  cpSync(EXAMPLES_DIR, examplesDir, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(EXAMPLES_DIR.length + 1);
      return !EXAMPLE_COPY_EXCLUDES.has(relative.split(/[\\/]/, 1)[0]);
    },
  });
  const modulesDir = join(dir, "node_modules");
  symlinkDir(resolve(REPO_ROOT, "packages/smithers"), join(modulesDir, "smithers-orchestrator"));
  symlinkDir(resolve(REPO_ROOT, "node_modules/@smithers-orchestrator"), join(modulesDir, "@smithers-orchestrator"));
  symlinkDir(resolve(REPO_ROOT, "node_modules/react"), join(modulesDir, "react"));
  symlinkDir(resolve(REPO_ROOT, "node_modules/react-dom"), join(modulesDir, "react-dom"));
  symlinkDir(resolve(REPO_ROOT, "node_modules/zod"), join(modulesDir, "zod"));
  writeFile(
    join(modulesDir, "ai/package.json"),
    JSON.stringify({ type: "module", exports: { ".": "./index.js" } }) + "\n",
  );
  writeFile(
    join(modulesDir, "ai/index.js"),
    [
      "export class ToolLoopAgent { constructor(opts = {}) { this.opts = opts; } }",
      "export const Output = { object(value) { return value; } };",
      "export function stepCountIs() { return () => false; }",
      "export function tool(def) { return def; }",
      "",
    ].join("\n"),
  );
  writeFile(
    join(modulesDir, "@ai-sdk/anthropic/package.json"),
    JSON.stringify({ type: "module", exports: { ".": "./index.js" } }) + "\n",
  );
  writeFile(
    join(modulesDir, "@ai-sdk/anthropic/index.js"),
    'export function anthropic(model) { return { provider: "anthropic", model }; }\n',
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const GRAPH_INPUT = {
  repo: ".",
  goal: "Smoke-test the committed example workflow graph",
  prompt: "Render this example without executing agents",
  change: "demo",
  diff: "diff --git a/example b/example",
  maxIterations: 1,
};
const GRAPH_CONCURRENCY = Math.min(8, availableParallelism());
const GRAPH_RENDER_TIMEOUT_MS = 60_000;

function findTopLevelExampleWorkflows() {
  return Array.from(new Bun.Glob("examples/*.jsx").scanSync({ cwd: REPO_ROOT })).sort();
}

async function renderExampleAttempt(projectDir, workerDir, example) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      CLI_ENTRY,
      "graph",
      resolve(projectDir, example),
      "--input",
      JSON.stringify(GRAPH_INPUT),
      "--format",
      "json",
    ],
    {
      cwd: workerDir,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-ant-test",
        OPENAI_API_KEY: "sk-test",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timeout;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, timedOut: false })),
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout({ exitCode: null, timedOut: true }), GRAPH_RENDER_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timeout);
  if (outcome.timedOut) {
    child.kill("SIGKILL");
    await child.exited.catch(() => undefined);
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return {
    error:
      outcome.exitCode === 0
        ? null
        : new Error(
            outcome.timedOut
              ? `graph subprocess timed out after ${GRAPH_RENDER_TIMEOUT_MS}ms`
              : `graph subprocess exited with code ${outcome.exitCode}`,
          ),
    stdout,
    stderr,
    timedOut: outcome.timedOut,
  };
}

async function renderExample(projectDir, workerDir, example) {
  const first = await renderExampleAttempt(projectDir, workerDir, example);
  if (!first.timedOut) return first;
  return renderExampleAttempt(projectDir, workerDir, example);
}

test("top-level example workflows render as graphs", async () => {
  const examples = findTopLevelExampleWorkflows();
  expect(examples).toContain("examples/smoketest.jsx");
  expect(examples.length).toBeGreaterThan(50);

  const project = createExampleProject();
  try {
    const results = new Array(examples.length);
    let nextExample = 0;
    await Promise.all(
      Array.from({ length: Math.min(GRAPH_CONCURRENCY, examples.length) }, async (_, workerIndex) => {
        const workerDir = join(project.dir, ".graph-workers", String(workerIndex));
        mkdirSync(workerDir, { recursive: true });
        while (nextExample < examples.length) {
          const index = nextExample++;
          results[index] = await renderExample(project.dir, workerDir, examples[index]);
        }
      }),
    );

    for (const [index, result] of results.entries()) {
      const example = examples[index];
      if (result.error) {
        throw new Error(
          `${example} failed (${result.error.message}):\nstdout:${result.stdout}\nstderr:${result.stderr}`,
        );
      }

      let graph;
      try {
        graph = JSON.parse(result.stdout);
      } catch (error) {
        throw new Error(
          `${example} emitted invalid JSON (${error instanceof Error ? error.message : String(error)}):\nstdout:${result.stdout}\nstderr:${result.stderr}`,
        );
      }
      expect(graph.xml?.kind, `${example} did not render an XML graph`).toBe("element");
      expect(Array.isArray(graph.tasks), `${example} did not expose graph tasks`).toBe(true);

      const source = readFileSync(resolve(REPO_ROOT, example), "utf8");
      expect(source.length, `${example} should be a committed source file`).toBeGreaterThan(0);
    }
  } finally {
    project.cleanup();
  }
  // 100+ examples, each a separate CLI subprocess at ~2.4s on an idle machine, so
  // the old 240s budget was exactly the serial runtime: one added example or any
  // competing load tipped it into a timeout that looked like a render failure
  // (the spawn is killed, so stdout/stderr come back empty).
}, 900_000);
