import { describe, expect, test } from "bun:test";
import { MemoryPromptCache } from "./MemoryPromptCache";
import type { CachedPrompt } from "./PromptCache";

const fixture: CachedPrompt = {
  key: "k",
  prompt: "p",
  structured: {},
  schema: "rctf",
  stakes: "low",
  score: 0.5,
  scoreReason: "r",
  createdAt: "2026-04-25T00:00:00.000Z",
  source: "extracted",
  overridden: false,
};

describe("MemoryPromptCache", () => {
  test("roundtrips a value", async () => {
    const c = new MemoryPromptCache();
    await c.set("k", fixture);
    expect(await c.get("k")).toEqual(fixture);
  });

  test("delete removes the value", async () => {
    const c = new MemoryPromptCache();
    await c.set("k", fixture);
    await c.delete("k");
    expect(await c.get("k")).toBeUndefined();
  });

  test("keys lists current entries", async () => {
    const c = new MemoryPromptCache();
    await c.set("a", { ...fixture, key: "a" });
    await c.set("b", { ...fixture, key: "b" });
    expect((await c.keys()).sort()).toEqual(["a", "b"]);
  });
});
