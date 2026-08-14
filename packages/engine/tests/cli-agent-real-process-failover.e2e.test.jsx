/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { SmithersDb } from "@smthrs/db/adapter";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { CodexAgent } from "@smthrs/agents";
import { Task, Workflow, runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";

const originalPath = process.env.PATH ?? "";

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.CODEX_CAPTURE_FILE;
});

class NoPreflightCodexAgent extends CodexAgent {
  async preflight() {}
}

async function makeFakeCodex() {
  const dir = await mkdtemp(join(tmpdir(), "smithers-engine-codex-"));
  const binPath = join(dir, "codex");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
if (process.env.CODEX_CAPTURE_FILE) {
  fs.writeFileSync(process.env.CODEX_CAPTURE_FILE, JSON.stringify({ args, stdin }), "utf8");
}
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex >= 0 && args[outputIndex + 1]) {
  fs.writeFileSync(args[outputIndex + 1], JSON.stringify({ value: 42 }), "utf8");
}
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-real-process" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { id: "assistant-1", type: "agent_message", text: JSON.stringify({ value: 13 }) }
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 17, output_tokens: 3, total_tokens: 20 }
}) + "\\n");
`;
  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);
  return { dir, binPath };
}

describe("CLI-backed agent fallback through the real process path", () => {
  test("engine failover runs a real CodexAgent subprocess and persists output-last-message JSON", async () => {
    const fake = await makeFakeCodex();
    const captureDir = await mkdtemp(join(tmpdir(), "smithers-engine-codex-capture-"));
    const captureFile = join(captureDir, "codex.json");
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.CODEX_CAPTURE_FILE = captureFile;

      let leadPreflightCalls = 0;
      let leadGenerateCalls = 0;
      const badLead = {
        id: "codex-auth-bad",
        model: "gpt-bad",
        cliEngine: "codex",
        tools: {},
        async preflight() {
          leadPreflightCalls += 1;
          throw new SmithersError("AGENT_CONFIG_INVALID", "OPENAI_API_KEY is invalid", {
            failureRetryable: false,
            preflight: true,
            agentEngine: "codex",
          });
        },
        async generate() {
          leadGenerateCalls += 1;
          throw new Error("the preflight-failed lead agent must not run");
        },
      };

      const realFallback = new NoPreflightCodexAgent({
        id: "codex-real-process-fallback",
        model: "gpt-5.4-codex",
        skipGitRepoCheck: true,
        env: {
          PATH: process.env.PATH,
          CODEX_CAPTURE_FILE: captureFile,
        },
      });

      const workflow = smithers(() => (
        <Workflow name="cli-agent-real-process-failover">
          <Task id="impl" output={outputs.outputA} agent={[badLead, realFallback]} retries={0}>
            Return the required value after checking the repository.
          </Task>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("finished");
      expect(leadPreflightCalls).toBe(1);
      expect(leadGenerateCalls).toBe(0);
      expect(db.select().from(tables.outputA).all()).toEqual([expect.objectContaining({ nodeId: "impl", value: 42 })]);

      const attempts = await adapter.listAttempts(result.runId, "impl", 0);
      expect(attempts).toHaveLength(1);
      const meta = JSON.parse(attempts[0]?.metaJson ?? "{}");
      expect(meta.agentId).toBe("codex-real-process-fallback");
      const checkpointRefs = await adapter.listAgentCheckpointRefs(result.runId, { nodeId: "impl" });
      expect(checkpointRefs.map((ref) => ref.sequence)).toEqual([0, 1]);
      expect(new Set(checkpointRefs.map((ref) => ref.contentHash)).size).toBe(1);
      for (const ref of checkpointRefs) {
        expect(ref).toMatchObject({ codec: "smithers.cli-session", version: 1, purpose: "session" });
      }
      const checkpointContent = await adapter.getAgentCheckpoint(checkpointRefs[0].contentHash);
      expect(JSON.parse(checkpointContent.checkpointJson)).toEqual({
        codec: "smithers.cli-session",
        version: 1,
        payload: { engine: "codex", resume: "thread-real-process" },
      });

      const captured = JSON.parse(await readFile(captureFile, "utf8"));
      expect(captured.args.slice(0, 1)).toEqual(["exec"]);
      expect(captured.args).toContain("--json");
      expect(captured.args).toContain("--output-last-message");
      expect(captured.args).toContain("--skip-git-repo-check");
      expect(captured.args).not.toContain("--output-schema");
      expect(captured.stdin).toContain("REQUIRED OUTPUT");
      expect(captured.stdin).toContain("Return the required value");
    } finally {
      cleanup();
      await rm(fake.dir, { recursive: true, force: true });
      await rm(captureDir, { recursive: true, force: true });
    }
  }, 20_000);
});
