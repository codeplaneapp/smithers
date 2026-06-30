import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HermesCliAgent } from "../src/index.js";
import { makeFakeNodeCli, prependPath } from "./fake-cli.js";

const originalPath = process.env.PATH ?? "";

/**
 * @param {string} stdoutScript
 */
async function makeFakeHermes(stdoutScript) {
  const dir = await mkdtemp(join(tmpdir(), "smithers-hermes-test-"));
  return makeFakeNodeCli(dir, "hermes", stdoutScript);
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.HERMES_ARGS_FILE;
});

const captureScript = `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.HERMES_ARGS_FILE) fs.writeFileSync(process.env.HERMES_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write("done\\n");
`;

describe("Hermes CLI agent", () => {
  test("HermesCliAgent builds the headless one-shot command", async () => {
    const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-hermes-args-"));
    const argsFile = join(argsFileDir, "args.json");
    const fake = await makeFakeHermes(captureScript);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      process.env.HERMES_ARGS_FILE = argsFile;
      const agent = new HermesCliAgent({
        model: "hermes-4",
        provider: "openrouter",
        env: { PATH: process.env.PATH, HERMES_ARGS_FILE: argsFile },
      });
      await agent.generate({
        messages: [
          { role: "system", content: "System instructions" },
          { role: "user", content: "Hello from user" },
        ],
      });
      const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
      expect(capturedArgs).toContain("--model");
      expect(capturedArgs).toContain("hermes-4");
      expect(capturedArgs).toContain("--provider");
      expect(capturedArgs).toContain("openrouter");
      // `-z` must be the last flag, with the prompt as its single value.
      const zIdx = capturedArgs.indexOf("-z");
      expect(zIdx).toBeGreaterThan(-1);
      expect(zIdx).toBe(capturedArgs.length - 2);
      const prompt = capturedArgs[zIdx + 1];
      expect(prompt).toContain("System instructions");
      expect(prompt).toContain("Hello from user");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("HermesCliAgent emits -r for a per-call resumeSession", async () => {
    const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-hermes-args-"));
    const argsFile = join(argsFileDir, "args.json");
    const fake = await makeFakeHermes(captureScript);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      process.env.HERMES_ARGS_FILE = argsFile;
      const agent = new HermesCliAgent({
        continueSession: "ignored-when-resuming",
        env: { PATH: process.env.PATH, HERMES_ARGS_FILE: argsFile },
      });
      await agent.generate({
        messages: [{ role: "user", content: "continue please" }],
        resumeSession: "sess-42",
      });
      const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
      expect(capturedArgs).toContain("-r");
      expect(capturedArgs).toContain("sess-42");
      // resumeSession wins: -c must not also be emitted.
      expect(capturedArgs).not.toContain("-c");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("HermesCliAgent emits -c for a configured continueSession", async () => {
    const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-hermes-args-"));
    const argsFile = join(argsFileDir, "args.json");
    const fake = await makeFakeHermes(captureScript);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      process.env.HERMES_ARGS_FILE = argsFile;
      const agent = new HermesCliAgent({
        continueSession: "latest",
        env: { PATH: process.env.PATH, HERMES_ARGS_FILE: argsFile },
      });
      await agent.generate({ messages: [{ role: "user", content: "go" }] });
      const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
      expect(capturedArgs).toContain("-c");
      expect(capturedArgs).toContain("latest");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("HermesCliAgent returns the final text output", async () => {
    const fake = await makeFakeHermes(`process.stdout.write("Paris is the capital of France\\n");`);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      const agent = new HermesCliAgent({ env: { PATH: process.env.PATH } });
      const result = await agent.generate({
        messages: [{ role: "user", content: "capital of France?" }],
      });
      expect(result.text).toBe("Paris is the capital of France");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("HermesCliAgent surfaces stderr on non-zero exit", async () => {
    const fake = await makeFakeHermes(`process.stderr.write("hermes blew up\\n");\nprocess.exit(7);`);
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      const agent = new HermesCliAgent({ env: { PATH: process.env.PATH } });
      await expect(
        agent.generate({ messages: [{ role: "user", content: "fail" }] }),
      ).rejects.toThrow(/hermes blew up/);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });
});
