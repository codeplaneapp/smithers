import { afterAll, onTestFinished } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
export const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");
const PROCESS_RUNNER = resolve(import.meta.dir, "e2e-process-runner.js");
const ROOT_NODE_MODULES = resolve(REPO_ROOT, "node_modules");
const BUN_BINARY = process.execPath;
const EXECUTABLE_SHEBANG = `#!${BUN_BINARY}`;
const activeProcessRecords = new Set();
const tempDirs = new Set();

function killProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function reapOwnedProcesses() {
  for (const record of activeProcessRecords) {
    reapProcessRecord(record);
  }
  activeProcessRecords.clear();
}

function reapProcessRecord(record) {
  try {
    const pid = Number(readFileSync(record.pidPath, "utf8"));
    killProcessGroup(pid);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  cleanupTempDir(record.dir);
}

afterAll(() => {
  reapOwnedProcesses();
});

process.once("exit", () => {
  reapOwnedProcesses();
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
});
export const FAKE_AGENT_RESPONSE = JSON.stringify({
  summary: "mock agent completed the task",
  prompt: "hello",
  reviewer: "mock-reviewer",
  approved: true,
  feedback: "looks good",
  issues: [],
  filesChanged: [],
  allTestsPassing: true,
  allPassed: true,
  failingSummary: null,
  polished: true,
  changesMade: [],
  steps: ["inspect", "implement", "verify"],
  tickets: [],
});
/**
 * @param {string} path
 */
function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}
/**
 * @param {string} path
 * @param {string} contents
 */
function writeFile(path, contents) {
  ensureDir(dirname(path));
  writeFileSync(path, contents, "utf8");
}
/**
 * @param {string} dir
 */
function cleanupTempDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  } catch (error) {
    // Windows can keep subprocess-created files locked briefly after the test
    // process exits. The assertions have already run, so don't fail on temp
    // teardown lag in CI.
    if (process.platform !== "win32" || !["EBUSY", "EPERM"].includes(error?.code)) {
      throw error;
    }
  }
}
/**
 * @param {string} target
 * @param {string} path
 * @param {"dir" | "file" | "junction"} [type]
 */
function symlinkIfMissing(target, path, type = "dir") {
  if (existsSync(path)) return;
  ensureDir(dirname(path));
  symlinkSync(target, path, type);
}
/**
 * @param {string} repoDir
 */
function linkRepoRuntimeDeps(repoDir) {
  const nodeModulesDir = join(repoDir, "node_modules");
  const binDir = join(nodeModulesDir, ".bin");
  ensureDir(nodeModulesDir);
  ensureDir(binDir);
  symlinkIfMissing(resolve(REPO_ROOT, "packages/smithers"), join(nodeModulesDir, "smithers-orchestrator"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "zod"), join(nodeModulesDir, "zod"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "react"), join(nodeModulesDir, "react"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "react-dom"), join(nodeModulesDir, "react-dom"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "typescript"), join(nodeModulesDir, "typescript"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "@types"), join(nodeModulesDir, "@types"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "@mdx-js"), join(nodeModulesDir, "@mdx-js"));
  // Runtime deps of the seeded multi-file UIs: the temp repo's gateway
  // bundles .smithers/ui/*.tsx, which imports these.
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "@xyflow"), join(nodeModulesDir, "@xyflow"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "@milkdown"), join(nodeModulesDir, "@milkdown"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "dagre"), join(nodeModulesDir, "dagre"));
  // mermaid is not hoisted to the root; use the .smithers copy — the seeded
  // pack's own manifest is what the temp repo's package.json mirrors.
  symlinkIfMissing(resolve(REPO_ROOT, ".smithers/node_modules/mermaid"), join(nodeModulesDir, "mermaid"));
  // create-workflow parses the skill doc it writes as real YAML frontmatter.
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "yaml"), join(nodeModulesDir, "yaml"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "typescript", "bin", "tsc"), join(binDir, "tsc"), "file");
}
/**
 * @returns {TempRepo}
 */
export function createTempRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "smithers-e2e-")));
  tempDirs.add(dir);
  onTestFinished(() => {
    cleanupTempDir(dir);
    tempDirs.delete(dir);
  });
  writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "smithers-e2e-fixture",
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
  );
  linkRepoRuntimeDeps(dir);
  return {
    dir,
    path: (...parts) => join(dir, ...parts),
    write(relativePath, contents) {
      const path = join(dir, relativePath);
      writeFile(path, contents);
      return path;
    },
    read(relativePath) {
      return readFileSync(join(dir, relativePath), "utf8");
    },
    exists(relativePath) {
      return existsSync(join(dir, relativePath));
    },
  };
}
/**
 * @param {string} stdout
 * @returns {unknown}
 */
function parseTrailingJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed];
  const lastObjectStart = trimmed.lastIndexOf("\n{");
  const lastArrayStart = trimmed.lastIndexOf("\n[");
  if (lastObjectStart >= 0) {
    candidates.push(trimmed.slice(lastObjectStart + 1));
  }
  if (lastArrayStart >= 0) {
    candidates.push(trimmed.slice(lastArrayStart + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return undefined;
}
/**
 * @param {string[]} args
 * @param {RunSmithersOptions} options
 * @returns {SmithersCliResult}
 */
export function runSmithers(args, options) {
  const cliArgs = options.format
    ? ["run", CLI_ENTRY, ...args, "--format", options.format]
    : ["run", CLI_ENTRY, ...args];
  const dir = mkdtempSync(join(tmpdir(), "smithers-e2e-process-"));
  const pidPath = join(dir, "pid");
  const resultPath = join(dir, "result.json");
  const configPath = join(dir, "config.json");
  const record = { dir, pidPath };
  activeProcessRecords.add(record);
  onTestFinished(() => {
    if (activeProcessRecords.delete(record)) {
      reapProcessRecord(record);
    }
  });
  const tempDir = tempDirs.has(options.cwd) ? options.cwd : undefined;
  writeFileSync(
    configPath,
    JSON.stringify({
      command: BUN_BINARY,
      args: cliArgs,
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs ?? 60_000,
      parentPid: process.pid,
      pidPath,
      resultPath,
      tempDir,
    }),
    "utf8",
  );
  let workerResult;
  try {
    workerResult = spawnSync(BUN_BINARY, ["run", PROCESS_RUNNER, configPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    let json;
    if (options.format === "json") {
      json = parseTrailingJson(stdout);
    }
    return {
      exitCode: result.status ?? (result.signal === "SIGTERM" ? 143 : 1),
      stdout,
      stderr,
      json,
    };
  } catch {
    const stdout = "";
    const stderr = workerResult?.stderr ?? "";
    return {
      exitCode: 1,
      stdout,
      stderr,
      json: undefined,
    };
  } finally {
    activeProcessRecords.delete(record);
    cleanupTempDir(dir);
  }
}
/**
 * Pin a workspace to the legacy bun:sqlite backend by writing
 * `.smithers/smithers.config.ts`. Read-command fixtures seed a SQLite store
 * directly, so they must declare `backend: "sqlite"` or the fail-loud migration
 * gate (default pglite) refuses to silently read the legacy store.
 *
 * @param {string} dir workspace root (the CLI cwd)
 */
export function pinSqliteBackend(dir) {
  writeFile(join(dir, ".smithers", "smithers.config.ts"), 'export default { backend: "sqlite" };\n');
}
/**
 * @param {string} dir
 * @param {Record<string, string | undefined>} [env]
 */
export function prependPath(dir, env) {
  const currentPath = env?.PATH ?? process.env.PATH ?? "";
  return {
    ...env,
    PATH: `${dir}${delimiter}${currentPath}`,
  };
}
/**
 * @param {TempRepo} repo
 */
export function writeTestWorkflow(repo, relativePath = "workflow.tsx") {
  return repo.write(
    relativePath,
    [
      "/** @jsxImportSource smithers-orchestrator */",
      'import { createSmithers, Workflow, Task } from "smithers-orchestrator";',
      'import { z } from "zod";',
      "",
      "const { smithers, outputs } = createSmithers({",
      "  result: z.object({",
      "    summary: z.string(),",
      "    prompt: z.string().nullable(),",
      "  }),",
      "});",
      "",
      "export default smithers((ctx) => (",
      '  <Workflow name="fixture-workflow">',
      '    <Task id="write-result" output={outputs.result}>',
      "      {{",
      '        summary: "fixture workflow ran",',
      "        prompt: ctx.input.prompt ?? null,",
      "      }}",
      "    </Task>",
      "  </Workflow>",
      "));",
      "",
    ].join("\n"),
  );
}
export function createExecutableDir(prefix = "smithers-fake-bin-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    cleanupTempDir(dir);
  });
  return dir;
}
/**
 * @param {string} dir
 * @param {string} name
 * @param {string} contents
 */
export function writeExecutable(dir, name, contents) {
  const path = join(dir, name);
  writeFile(path, contents);
  chmodSync(path, 0o755);
  if (process.platform === "win32") {
    const wrapperPath = `${path}.cmd`;
    writeFile(wrapperPath, ["@echo off", `"${process.execPath}" "%~dp0${name}" %*`, ""].join("\r\n"));
    return wrapperPath;
  }
  return path;
}
/**
 * @param {string} dir
 */
export function writeFakeClaudeBinary(dir, response = FAKE_AGENT_RESPONSE) {
  return writeExecutable(
    dir,
    "claude",
    [
      EXECUTABLE_SHEBANG,
      "const args = process.argv.slice(2);",
      "if (args.join(' ') === 'auth status') {",
      "  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\\n');",
      "  process.exit(0);",
      "}",
      "const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? " + JSON.stringify(response) + ";",
      "process.stdout.write(JSON.stringify({",
      '  type: "turn_end",',
      "  message: {",
      '    role: "assistant",',
      '    content: [{ type: "text", text: "```json\\n" + payload + "\\n```\\n" }],',
      "  },",
      '}) + "\\n");',
      "",
    ].join("\n"),
  );
}
/**
 * @param {string} dir
 */
export function writeFakeCodexBinary(dir, response = FAKE_AGENT_RESPONSE) {
  return writeExecutable(
    dir,
    "codex",
    [
      EXECUTABLE_SHEBANG,
      'const fs = require("node:fs");',
      "const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? " + JSON.stringify(response) + ";",
      "const args = process.argv.slice(2);",
      'const outputIndex = args.indexOf("--output-last-message");',
      "if (outputIndex >= 0 && args[outputIndex + 1]) {",
      '  fs.writeFileSync(args[outputIndex + 1], "```json\\n" + payload + "\\n```\\n", "utf8");',
      "}",
      'process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");',
      "",
    ].join("\n"),
  );
}
/**
 * @param {string} dir
 */
export function writeFakeOpenCodeBinary(dir, response = FAKE_AGENT_RESPONSE) {
  return writeExecutable(
    dir,
    "opencode",
    [
      EXECUTABLE_SHEBANG,
      "const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? " + JSON.stringify(response) + ";",
      "process.stdout.write(JSON.stringify({",
      '  type: "text",',
      "  part: {",
      '    type: "text",',
      '    text: "```json\\n" + payload + "\\n```\\n",',
      "  },",
      '}) + "\\n");',
      'process.stdout.write(JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "done" } }) + "\\n");',
      "",
    ].join("\n"),
  );
}
/**
 * @param {string} dir
 */
export function writeFakeOpenClawBinary(dir, response = FAKE_AGENT_RESPONSE) {
  return writeExecutable(
    dir,
    "openclaw",
    [
      EXECUTABLE_SHEBANG,
      "const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? " + JSON.stringify(response) + ";",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'status') {",
      "  process.stdout.write('OpenClaw gateway ready\\nProvider: test\\n');",
      "  process.exit(0);",
      "}",
      "process.stdout.write(JSON.stringify({ reply: '```json\\n' + payload + '\\n```\\n' }) + '\\n');",
      "",
    ].join("\n"),
  );
}
/**
 * @param {string} dir
 */
export function writeFakeGeminiBinary(dir, response = FAKE_AGENT_RESPONSE) {
  return writeExecutable(
    dir,
    "gemini",
    [
      EXECUTABLE_SHEBANG,
      "const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? " + JSON.stringify(response) + ";",
      'process.stdout.write(JSON.stringify({ text: "```json\\n" + payload + "\\n```\\n" }) + "\\n");',
      "",
    ].join("\n"),
  );
}
/**
 * @param {string} dir
 */
export function writeFakeAntigravityBinary(dir, response = FAKE_AGENT_RESPONSE) {
  return writeExecutable(
    dir,
    "agy",
    [
      EXECUTABLE_SHEBANG,
      "const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? " + JSON.stringify(response) + ";",
      'process.stdout.write(payload + "\\n");',
      "",
    ].join("\n"),
  );
}
