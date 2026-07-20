import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenClawAgent } from "../src/OpenClawAgent.js";
import { PiAgent } from "../src/PiAgent.js";
import { makeFakeNodeCli, prependPath } from "./fake-cli.js";

const originalPath = process.env.PATH ?? "";

afterEach(() => {
  process.env.PATH = originalPath;
});

// ---------------------------------------------------------------------------
// OpenClawAgent — the JSON-error fallback (extractOpenClawError) fires when the
// CLI exits non-zero with no stderr but a JSON `error` field on stdout.
// ---------------------------------------------------------------------------
describe("OpenClawAgent error extraction", () => {
  test("surfaces a JSON error field when the CLI exits non-zero without stderr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-openclaw-err-"));
    const fake = await makeFakeNodeCli(
      dir,
      "openclaw",
      `process.stdout.write(JSON.stringify({ error: "openclaw json failure" }) + "\\n");\nprocess.exit(3);`,
    );
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      const agent = new OpenClawAgent({ env: { PATH: process.env.PATH } });
      await expect(
        agent.generate({ messages: [{ role: "user", content: "do work" }] }),
      ).rejects.toThrow(/openclaw json failure/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// PiAgent RPC mode — a failing prompt response settles the RPC program as an
// error, which runs the diagnostics-enrichment tapError branch.
// ---------------------------------------------------------------------------
describe("PiAgent RPC diagnostics enrichment", () => {
  test("attaches diagnostics to the error when an RPC prompt fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-pi-rpc-fail-"));
    const fake = await makeFakeNodeCli(
      dir,
      "pi",
      `const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "prompt") {
    process.stdout.write(JSON.stringify({ type: "response", command: "prompt", success: false, error: "pi rpc rejected" }) + "\\n");
  }
});`,
    );
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      const agent = new PiAgent({
        mode: "rpc",
        model: "gpt-5.4-mini",
        env: { PATH: process.env.PATH },
      });
      let error;
      try {
        await agent.generate({ messages: [{ role: "user", content: "Ping?" }] });
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(error.message).toContain("pi rpc rejected");
      // launchDiagnostics("pi", ...) resolves a report (the fake pi is on PATH),
      // so the tapError enrichment branch attaches it to the SmithersError.
      expect(error.details?.diagnostics?.agentId).toBe("pi");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
});
