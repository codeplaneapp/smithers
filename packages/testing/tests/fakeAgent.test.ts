import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { auto, fakeAgent } from "../src/index.ts";

const resultSchema = z.object({
  summary: z.string(),
  passed: z.boolean(),
});

describe("fakeAgent", () => {
  test("validates output and records calls", async () => {
    const agent = fakeAgent(resultSchema, {
      output: { summary: "done", passed: true },
    });

    const result = await agent.generate({ prompt: "check status" });

    expect(result).toEqual({ output: { summary: "done", passed: true } });
    expect(agent.calls).toHaveLength(1);
    expect(agent.lastPrompt()).toBe("check status");
  });

  test("fills output from the schema example sentinel", async () => {
    const agent = fakeAgent(resultSchema, auto);

    const result = await agent.generate();

    expect(result).toEqual({ output: { summary: "string", passed: false } });
  });

  test("consumes scripted sequence entries in order", async () => {
    const agent = fakeAgent.sequence(resultSchema, [
      { output: { summary: "first", passed: false } },
      { output: { summary: "second", passed: true } },
    ]);

    await expect(agent.generate()).resolves.toEqual({ output: { summary: "first", passed: false } });
    await expect(agent.generate()).resolves.toEqual({ output: { summary: "second", passed: true } });
    await expect(agent.generate()).rejects.toThrow("sequence exhausted");
  });

  test("writes declared files under rootDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-testing-"));
    try {
      const agent = fakeAgent(resultSchema, {
        output: { summary: "wrote", passed: true },
        files: {
          "src/result.ts": "export const result = true;\n",
        },
      });

      await agent.generate({ rootDir: dir });

      await expect(readFile(join(dir, "src/result.ts"), "utf8")).resolves.toBe("export const result = true;\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid structured output", async () => {
    const agent = fakeAgent(resultSchema, {
      output: { summary: "bad", passed: "yes" },
    } as never);

    await expect(agent.generate()).rejects.toThrow("failed validation");
  });
});
