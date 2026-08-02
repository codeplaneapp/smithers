import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import {
  createExecutableDir,
  createTempRepo,
  prependPath,
  runSmithers,
  writeExecutable,
} from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * @param {string} dbPath
 */
function openRepoDb(dbPath) {
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return {
    sqlite,
    adapter: new SmithersDb(db),
  };
}

test("chat create starts an auto-hijacked run and returns JSON metadata", async () => {
  const repo = createTempRepo();
  repo.write("workspace/.gitkeep", "\n");
  const launchFile = repo.path("chat-create-launch.json");
  const binDir = createExecutableDir();
  writeExecutable(
    binDir,
    "codex",
    [
      "#!/usr/bin/env node",
      'const { writeFileSync } = require("node:fs");',
      "const target = process.env.SMITHERS_CHAT_CREATE_FILE;",
      'if (target) writeFileSync(target, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }), "utf8");',
      'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "chat-thread-1" }) + "\\n");',
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  // Real local OpenAI-compatible endpoint so codex's preflight validates the
  // key against a deterministic 200 instead of api.openai.com. It runs in a
  // separate process because runSmithers blocks on spawnSync, which would
  // freeze an in-process server. No mocks: a real HTTP server, real responses.
  const portFile = repo.path("openai-fixture-port.txt");
  const fixturePath = writeExecutable(
    binDir,
    "openai-fixture",
    [
      "#!/usr/bin/env node",
      'const { createServer } = require("node:http");',
      'const { writeFileSync } = require("node:fs");',
      "const server = createServer((_req, res) => {",
      '    res.writeHead(200, { "content-type": "application/json" });',
      '    res.end(JSON.stringify({ object: "list", data: [] }));',
      "});",
      'server.listen(0, "127.0.0.1", () => {',
      "    writeFileSync(process.env.OPENAI_FIXTURE_PORT_FILE, String(server.address().port));",
      "});",
      "",
    ].join("\n"),
  );
  const fixture = Bun.spawn([fixturePath], {
    env: { ...process.env, OPENAI_FIXTURE_PORT_FILE: portFile },
    stdout: "ignore",
    stderr: "ignore",
  });
  let fixturePort = "";
  for (let i = 0; i < 200 && !fixturePort; i += 1) {
    if (existsSync(portFile)) fixturePort = readFileSync(portFile, "utf8").trim();
    if (!fixturePort) await Bun.sleep(10);
  }
  if (!fixturePort) throw new Error("openai fixture server did not report a port");

  try {
    const result = runSmithers(
      [
        "chat",
        "create",
        "--agent",
        "codex",
        "--cwd",
        "workspace",
        "--started-by-harness",
        "explicit-harness",
        "--started-by-session",
        "explicit-session",
        "--started-by-prompt",
        "explicit launch context",
      ],
      {
        cwd: repo.dir,
        format: "json",
        env: {
          ...prependPath(binDir),
          SMITHERS_CHAT_CREATE_FILE: launchFile,
          // Validate the (fake) key against the local fixture above so the
          // preflight passes without a real key or network egress.
          OPENAI_API_KEY: "sk-test-local-fixture",
          OPENAI_BASE_URL: `http://127.0.0.1:${fixturePort}/v1`,
        },
      },
    );
    // Surface the spawned CLI's output when it fails: a bare exit-code
    // assertion hides why `smithers chat create` died, which makes
    // environment-specific failures (e.g. CI-only) impossible to diagnose.
    if (result.exitCode !== 0) {
      throw new Error(
        `smithers chat create exited ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      workflowName: "chat",
      agent: "codex",
    });
    expect(typeof result.json?.runId).toBe("string");
    const launched = JSON.parse(repo.read("chat-create-launch.json"));
    expect(launched.cwd).toBe(repo.path("workspace"));
    const { sqlite, adapter } = openRepoDb(repo.path("workspace", "smithers.db"));
    try {
      const run = await adapter.getRun(result.json.runId);
      expect(run).toMatchObject({
        runId: result.json.runId,
        workflowName: "chat",
        status: "cancelled",
      });
      expect(JSON.parse(run.configJson).startedBy).toEqual({
        harness: "explicit-harness",
        sessionId: "explicit-session",
        prompt: "explicit launch context",
      });
      const attempts = await adapter.listAttempts(result.json.runId, "chat", 0);
      expect(attempts).toHaveLength(1);
      const meta = JSON.parse(attempts[0].metaJson);
      expect(meta.agentEngine).toBe("codex");
      expect(meta.agentResume).toBe("chat-thread-1");
      expect(meta.hijackHandoff).toMatchObject({
        engine: "codex",
        mode: "native-cli",
        resume: "chat-thread-1",
      });
    } finally {
      sqlite.close();
    }
  } finally {
    fixture.kill();
  }
});
