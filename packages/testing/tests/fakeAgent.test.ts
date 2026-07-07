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

  test("returns a text/files wrapper with no output when the schema rejects a text-only result", async () => {
    // The result carries wrapper keys but its (absent) output cannot validate,
    // so normalizeResult returns the text/files wrapper verbatim and still
    // writes the declared files.
    const dir = await mkdtemp(join(tmpdir(), "smithers-testing-"));
    try {
      const agent = fakeAgent(resultSchema, {
        text: "just text",
        files: { "a.txt": "x" },
      });
      const result = await agent.generate({ rootDir: dir });
      expect(result).toEqual({ text: "just text" });
      await expect(readFile(join(dir, "a.txt"), "utf8")).resolves.toBe("x");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("formats non-message validation issues via JSON.stringify", async () => {
    // A custom SafeSchema whose failure issues are bare strings (not objects
    // with a `message`) exercises the JSON.stringify fallback in formatIssues,
    // and the bare-output assertSchema fallthrough in normalizeResult.
    const failSchema = {
      safeParse() {
        return { success: false as const, error: { issues: ["boom"] } };
      },
    };
    const agent = fakeAgent(failSchema, "bare-value");
    await expect(agent.generate()).rejects.toThrow('Fake agent output failed validation: "boom"');
  });

  test("throws when declared files are given without a rootDir", async () => {
    const agent = fakeAgent(z.any(), {
      output: { ok: true },
      files: { "note.txt": "hi\n" },
    });
    await expect(agent.generate()).rejects.toThrow("Fake agent files require a rootDir");
  });

  test("rejects a resolved path that escapes rootDir despite passing the segment check", async () => {
    // "..foo" has no ".." *segment* (so the segment guard admits it) yet its
    // path resolves to a name beginning with ".." relative to rootDir, which the
    // second resolution guard rejects.
    const dir = await mkdtemp(join(tmpdir(), "smithers-testing-"));
    try {
      const agent = fakeAgent(resultSchema, {
        output: { summary: "ok", passed: true },
        files: { "..foo": "y" },
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
