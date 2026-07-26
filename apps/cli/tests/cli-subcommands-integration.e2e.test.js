import { expect, onTestFinished, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  createExecutableDir,
  createTempRepo,
  pinSqliteBackend,
  runSmithers,
  writeFakeClaudeBinary,
  writeTestWorkflow,
} from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function quietEnv(extra = {}) {
  return {
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CI: "1",
    SMITHERS_NO_SKILL_REFRESH: "1",
    ...extra,
  };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function stopProcess(child, closePromise) {
  if (child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
  }
  const closed = await Promise.race([closePromise.then(() => true), sleep(2_000).then(() => false)]);
  if (!closed) {
    child.kill("SIGKILL");
    await closePromise;
  }
}

function spawnSmithers(args, { cwd, env = {} }) {
  const child = spawn(process.execPath, ["run", CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, ...quietEnv(env) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closePromise = new Promise((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  onTestFinished(() => stopProcess(child, closePromise));
  return { child, closePromise, stdout: () => stdout, stderr: () => stderr };
}

test("cron add/list/rm persist schedules and cron start exits cleanly on SIGTERM", async () => {
  const repo = createTempRepo();
  pinSqliteBackend(repo.dir);
  writeTestWorkflow(repo, "workflow.tsx");

  const seedRun = runSmithers(["workflow.tsx"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv({ SMITHERS_BACKEND: "sqlite" }),
    timeoutMs: 60_000,
  });
  expect(seedRun.exitCode, `${seedRun.stdout}\n${seedRun.stderr}`).toBe(0);

  const empty = runSmithers(["cron", "list"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv({ SMITHERS_BACKEND: "sqlite" }),
  });
  expect(empty.exitCode).toBe(0);
  expect(empty.json?.crons).toEqual([]);

  const add = runSmithers(["cron", "add", "*/5 * * * *", "workflow.tsx"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv({ SMITHERS_BACKEND: "sqlite" }),
  });
  expect(add.exitCode, `${add.stdout}\n${add.stderr}`).toBe(0);
  expect(add.json).toMatchObject({ pattern: "*/5 * * * *", workflowPath: "workflow.tsx" });
  const cronId = add.json?.cronId;
  expect(typeof cronId).toBe("string");

  const one = runSmithers(["cron", "list"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv({ SMITHERS_BACKEND: "sqlite" }),
  });
  expect(one.exitCode).toBe(0);
  expect(one.json?.crons).toHaveLength(1);
  expect(one.json?.crons[0]).toMatchObject({
    cronId,
    pattern: "*/5 * * * *",
    workflowPath: "workflow.tsx",
    enabled: true,
  });

  const removed = runSmithers(["cron", "rm", cronId], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv({ SMITHERS_BACKEND: "sqlite" }),
  });
  expect(removed.exitCode).toBe(0);
  expect(removed.json).toMatchObject({ deleted: cronId });

  const afterRm = runSmithers(["cron", "list"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv({ SMITHERS_BACKEND: "sqlite" }),
  });
  expect(afterRm.exitCode).toBe(0);
  expect(afterRm.json?.crons).toEqual([]);

  const scheduler = spawnSmithers(["cron", "start"], {
    cwd: repo.dir,
    env: { SMITHERS_BACKEND: "sqlite" },
  });
  await sleep(500);
  expect(scheduler.child.exitCode, `${scheduler.stdout()}\n${scheduler.stderr()}`).toBeNull();
  scheduler.child.kill("SIGTERM");
  const exit = await scheduler.closePromise;
  expect(exit.code === 0 || exit.signal === "SIGTERM", `${scheduler.stdout()}\n${scheduler.stderr()}`).toBe(true);
}, 90_000);

test("cron add rejects an invalid cron pattern without persisting a schedule", () => {
  const repo = createTempRepo();
  pinSqliteBackend(repo.dir);
  writeTestWorkflow(repo, "workflow.tsx");

  const seedRun = runSmithers(["workflow.tsx"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv({ SMITHERS_BACKEND: "sqlite" }),
    timeoutMs: 60_000,
  });
  expect(seedRun.exitCode, `${seedRun.stdout}\n${seedRun.stderr}`).toBe(0);

  const rejected = runSmithers(["cron", "add", "not a cron pattern", "workflow.tsx"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv({ SMITHERS_BACKEND: "sqlite" }),
  });
  expect(rejected.exitCode).not.toBe(0);
  expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("INVALID_CRON_PATTERN");
  expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("Invalid cron pattern");

  const listed = runSmithers(["cron", "list"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv({ SMITHERS_BACKEND: "sqlite" }),
  });
  expect(listed.exitCode, `${listed.stdout}\n${listed.stderr}`).toBe(0);
  expect(listed.json?.crons).toEqual([]);
}, 75_000);

test("openapi list/generate handles empty and single-operation specs through the real CLI", async () => {
  const repo = createTempRepo();
  repo.write(
    "empty-openapi.json",
    `${JSON.stringify({ openapi: "3.0.0", info: { title: "Empty", version: "1.0.0" }, paths: {} }, null, 2)}\n`,
  );
  const empty = runSmithers(["openapi", "list", "empty-openapi.json"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv(),
  });
  expect(empty.exitCode, `${empty.stdout}\n${empty.stderr}`).toBe(0);
  expect(empty.json?.operations).toEqual([]);

  repo.write(
    "petstore-openapi.json",
    `${JSON.stringify(
      {
        openapi: "3.0.0",
        info: { title: "Petstore", version: "1.0.0" },
        servers: [{ url: "https://example.test/api" }],
        paths: {
          "/pets/{petId}": {
            get: {
              operationId: "getPet",
              summary: "Fetch a pet",
              parameters: [
                {
                  name: "petId",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: {
                200: {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { id: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const listed = runSmithers(["openapi", "list", "petstore-openapi.json"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv(),
  });
  expect(listed.exitCode, `${listed.stdout}\n${listed.stderr}`).toBe(0);
  expect(listed.json?.operations).toHaveLength(1);
  expect(listed.json?.operations[0]).toMatchObject({
    operationId: "getPet",
    method: "GET",
    path: "/pets/{petId}",
  });

  const generated = runSmithers(["openapi", "generate", "petstore-openapi.json", "generated/tools.js"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv(),
  });
  expect(generated.exitCode, `${generated.stdout}\n${generated.stderr}`).toBe(0);
  expect(generated.json).toMatchObject({ toolCount: 1, outputPath: repo.path("generated/tools.js") });
  expect(repo.read("generated/tools.js")).toContain("createOpenApiToolsSync");

  const mod = await import(`${pathToFileURL(repo.path("generated/tools.js")).href}?t=${Date.now()}`);
  expect(Object.keys(mod.tools)).toEqual(["getPet"]);
}, 45_000);

test("openapi list/generate reject invalid specs without writing generated output", () => {
  const repo = createTempRepo();
  repo.write("invalid-openapi.json", `${JSON.stringify({ info: { title: "Missing Version" }, paths: {} }, null, 2)}\n`);

  const listed = runSmithers(["openapi", "list", "invalid-openapi.json"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv(),
  });
  expect(listed.exitCode).not.toBe(0);
  expect(listed.json?.code).toBe("OPENAPI_LIST_FAILED");
  expect(`${listed.stdout}\n${listed.stderr}`).toContain("does not appear to be a valid OpenAPI spec");

  const generated = runSmithers(["openapi", "generate", "invalid-openapi.json", "generated/tools.js"], {
    cwd: repo.dir,
    format: "json",
    env: quietEnv(),
  });
  expect(generated.exitCode).not.toBe(0);
  expect(generated.json?.code).toBe("OPENAPI_GENERATE_FAILED");
  expect(`${generated.stdout}\n${generated.stderr}`).toContain("does not appear to be a valid OpenAPI spec");
  expect(existsSync(repo.path("generated/tools.js"))).toBe(false);
}, 30_000);

test("token issue/exec/revoke round-trips a brokered action token through a child process", () => {
  const repo = createTempRepo();
  const env = quietEnv({ SMITHERS_TOKEN_STORE: repo.path(".smithers", "tokens.json") });
  const issued = runSmithers(["token", "issue", "--scopes", "run:read cron:write", "--ttl", "15m", "--reveal-token"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(issued.exitCode, `${issued.stdout}\n${issued.stderr}`).toBe(0);
  expect(issued.json?.token).toStartWith("smithers_");
  expect(issued.json?.grant.scopes).toEqual(["run:read", "cron:write"]);
  const handle = issued.json?.actionToken?.handle;
  expect(handle).toStartWith("smithers_action_");

  const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.env.SMITHERS_TEST_TOKEN?.startsWith('smithers_') ? 'TOKEN_OK\\\\n' : 'TOKEN_BAD\\\\n')"`;
  const executed = runSmithers(
    ["token", "exec", "--handle", handle, "--scopes", "run:read", "--env", "SMITHERS_TEST_TOKEN", "--command", command],
    { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 },
  );
  expect(executed.exitCode, `${executed.stdout}\n${executed.stderr}`).toBe(0);
  expect(executed.stdout).toContain("TOKEN_OK");
  expect(executed.json).toMatchObject({
    ok: true,
    tokenId: issued.json?.grant.tokenId,
    actionId: "gateway",
  });

  const revoked = runSmithers(["token", "revoke", issued.json.token], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(revoked.exitCode).toBe(0);
  expect(revoked.json).toMatchObject({ revoked: true, tokenId: issued.json?.grant.tokenId });

  const denied = runSmithers(
    ["token", "exec", "--handle", handle, "--scopes", "run:read", "--env", "SMITHERS_TEST_TOKEN", "--command", command],
    { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 },
  );
  expect(denied.exitCode).toBe(1);
  expect(`${denied.stdout}\n${denied.stderr}`).toContain("revoked");
}, 45_000);

test("agents capabilities/doctor/test exercise the CLI registry and a spawned account binary", () => {
  const repo = createTempRepo();
  const home = tempDir("smithers-agents-cli-");
  const binDir = createExecutableDir();
  writeFakeClaudeBinary(binDir);
  const env = quietEnv({
    HOME: home,
    SMITHERS_HOME: home,
    PATH: [binDir, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
  });

  const capabilities = runSmithers(["agents", "capabilities"], {
    cwd: repo.dir,
    format: null,
    env,
  });
  expect(capabilities.exitCode, `${capabilities.stdout}\n${capabilities.stderr}`).toBe(0);
  const capabilityReport = JSON.parse(capabilities.stdout);
  expect(capabilityReport.some((entry) => entry.id === "claude" && entry.binary === "claude")).toBe(true);

  const doctor = runSmithers(["agents", "doctor", "--json"], {
    cwd: repo.dir,
    format: null,
    env,
  });
  expect(doctor.exitCode, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
  expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: true, issueCount: 0 });

  const added = runSmithers(["agents", "add", "--provider", "claude-code", "--label", "claude-ci", "--skip-login"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(added.exitCode, `${added.stdout}\n${added.stderr}`).toBe(0);

  const ping = runSmithers(["agents", "test", "claude-ci"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(ping.exitCode, `${ping.stdout}\n${ping.stderr}`).toBe(0);
  expect(ping.stdout).toContain("Ran:");
  expect(ping.json).toMatchObject({
    account: { label: "claude-ci", provider: "claude-code" },
    ping: { ran: true, exitCode: 0 },
  });
}, 45_000);

test("mcp add and skills add run supplementary Hermes and Pi wiring from the real CLI", () => {
  const repo = createTempRepo();
  const home = tempDir("smithers-extra-agent-wiring-");
  mkdirSync(join(home, ".hermes"), { recursive: true });
  mkdirSync(join(home, ".pi"), { recursive: true });
  const env = quietEnv({
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    PATH: process.env.PATH ?? "",
  });

  const mcp = runSmithers(["mcp", "add", "--agent", "hermes", "--command", "bunx smithers-orchestrator --mcp"], {
    cwd: repo.dir,
    format: null,
    env,
    timeoutMs: 90_000,
  });
  expect(mcp.exitCode, `${mcp.stdout}\n${mcp.stderr}`).toBe(0);
  expect(mcp.stderr).toContain("Hermes");
  const hermesConfig = parseYaml(readFileSync(join(home, ".hermes", "config.yaml"), "utf8"));
  expect(hermesConfig.mcp_servers.smithers).toEqual({
    command: "bunx",
    args: ["smithers-orchestrator", "--mcp"],
  });
  expect(existsSync(join(home, ".hermes", "plugins", "smithers", "plugin.yaml"))).toBe(true);

  const skills = runSmithers(["skills", "add", "--agent", "pi"], {
    cwd: repo.dir,
    format: null,
    env,
    timeoutMs: 120_000,
  });
  expect(skills.exitCode, `${skills.stdout}\n${skills.stderr}`).toBe(0);
  expect(skills.stderr).toContain("Pi");
  expect(existsSync(join(home, ".pi", "agent", "skills", "smithers-token", "SKILL.md"))).toBe(true);
}, 150_000);
