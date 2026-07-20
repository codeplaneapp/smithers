import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fakeAgent } from "../src/index.ts";

test("fakeAgent honors a text/files-only wrapper under a permissive schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "smithers-testing-"));
  try {
    const agent = fakeAgent(z.any(), {
      text: "done",
      files: { "out.txt": "hi\n" },
    });

    const result = await agent.generate({ rootDir: dir });

    expect(result).toEqual({ text: "done" });
    await expect(readFile(join(dir, "out.txt"), "utf8")).resolves.toBe("hi\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
