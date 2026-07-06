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

  test("honors a wrapper (output+files) even under a permissive schema", async () => {
    // A fully-permissive schema would let the WHOLE wrapper validate as the bare
    // output, silently swallowing text/files. The wrapper must win when its
    // nested `output` validates.
    const dir = await mkdtemp(join(tmpdir(), "smithers-testing-"));
    try {
      const agent = fakeAgent(z.any(), {
        output: { ok: true },
        files: { "note.txt": "hi\n" },
      });
      const result = await agent.generate({ rootDir: dir });
      expect(result.output).toEqual({ ok: true });
      await expect(readFile(join(dir, "note.txt"), "utf8")).resolves.toBe("hi\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("treats a bare output whose own fields are named output/text as the output", async () => {
    // The schema itself has `output`/`text` fields — the value must be read as
    // the bare output, not misparsed as the {output,text,files} wrapper.
    const nestedSchema = z.object({ output: z.string(), text: z.string() });
    const agent = fakeAgent(nestedSchema, { output: "payload", text: "note" });
    await expect(agent.generate()).resolves.toEqual({ output: { output: "payload", text: "note" } });
  });

  test("rejects absolute file paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-testing-"));
    try {
      const agent = fakeAgent(resultSchema, {
        output: { summary: "ok", passed: true },
        files: { "/etc/x": "y" },
      });
      await expect(agent.generate({ rootDir: dir })).rejects.toThrow("must stay inside rootDir");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects .. traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-testing-"));
    try {
      const agent = fakeAgent(resultSchema, {
        output: { summary: "ok", passed: true },
        files: { "../x": "y" },
      });
      await expect(agent.generate({ rootDir: dir })).rejects.toThrow("must stay inside rootDir");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("function script receives args and reset clears calls", async () => {
    const agent = fakeAgent(resultSchema, () => ({ output: { summary: "done", passed: true } }));

    await agent.generate({ prompt: "p" });
    expect(agent.calls[0].args.prompt).toBe("p");

    agent.reset();
    expect(agent.calls).toHaveLength(0);
  });
});
