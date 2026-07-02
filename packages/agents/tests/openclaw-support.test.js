import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenClawAgent } from "../src/index.js";
import { makeFakeNodeCli, prependPath } from "./fake-cli.js";

const originalPath = process.env.PATH ?? "";

/**
 * @param {string} stdoutScript
 */
async function makeFakeOpenClaw(stdoutScript) {
  const dir = await mkdtemp(join(tmpdir(), "smithers-openclaw-test-"));
  return makeFakeNodeCli(dir, "openclaw", stdoutScript);
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.OPENCLAW_ARGS_FILE;
});

const captureScript = `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCLAW_ARGS_FILE) fs.writeFileSync(process.env.OPENCLAW_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write(JSON.stringify({ reply: "done" }) + "\\n");
`;

describe("OpenClaw CLI agent", () => {
  test("OpenClawAgent builds the gateway-backed one-shot agent command", async () => {
    const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-openclaw-args-"));
    const argsFile = join(argsFileDir, "args.json");
    const fake = await makeFakeOpenClaw(captureScript);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      process.env.OPENCLAW_ARGS_FILE = argsFile;
      const agent = new OpenClawAgent({
        agent: "main",
        workspace: "/workspace",
        env: { PATH: process.env.PATH, OPENCLAW_ARGS_FILE: argsFile },
      });
      await agent.generate({
        messages: [
          { role: "system", content: "System instructions" },
          { role: "user", content: "Hello from user" },
        ],
      });
      const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
      expect(capturedArgs[0]).toBe("agent");
      expect(capturedArgs).toContain("--agent");
      expect(capturedArgs).toContain("main");
      expect(capturedArgs).toContain("--workspace");
      expect(capturedArgs).toContain("/workspace");
      expect(capturedArgs).toContain("--json");
      const messageIdx = capturedArgs.indexOf("--message");
      expect(messageIdx).toBeGreaterThan(-1);
      const prompt = capturedArgs[messageIdx + 1];
      expect(prompt).toContain("System instructions");
      expect(prompt).toContain("Hello from user");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("OpenClawAgent maps resumeSession to --session", async () => {
    const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-openclaw-args-"));
    const argsFile = join(argsFileDir, "args.json");
    const fake = await makeFakeOpenClaw(captureScript);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      process.env.OPENCLAW_ARGS_FILE = argsFile;
      const agent = new OpenClawAgent({
        session: "configured",
        env: { PATH: process.env.PATH, OPENCLAW_ARGS_FILE: argsFile },
      });
      await agent.generate({
        messages: [{ role: "user", content: "continue please" }],
        resumeSession: "run-session",
      });
      const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
      expect(capturedArgs).toContain("--session");
      expect(capturedArgs).toContain("run-session");
      expect(capturedArgs).not.toContain("configured");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("OpenClawAgent returns JSON reply text", async () => {
    const fake = await makeFakeOpenClaw(`process.stdout.write(JSON.stringify({ result: { message: "openclaw finished" } }) + "\\n");`);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      const agent = new OpenClawAgent({ env: { PATH: process.env.PATH } });
      const result = await agent.generate({
        messages: [{ role: "user", content: "do work" }],
      });
      expect(result.text).toBe("openclaw finished");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("OpenClawAgent returns plain text when JSON output is disabled", async () => {
    const fake = await makeFakeOpenClaw(`process.stdout.write("plain answer\\n");`);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      const agent = new OpenClawAgent({ json: false, env: { PATH: process.env.PATH } });
      const result = await agent.generate({
        messages: [{ role: "user", content: "do work" }],
      });
      expect(result.text).toBe("plain answer");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("OpenClawAgent surfaces stderr on non-zero exit", async () => {
    const fake = await makeFakeOpenClaw(`process.stderr.write("openclaw failed\\n");\nprocess.exit(5);`);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      const agent = new OpenClawAgent({ env: { PATH: process.env.PATH } });
      await expect(
        agent.generate({ messages: [{ role: "user", content: "fail" }] }),
      ).rejects.toThrow(/openclaw failed/);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });
});
