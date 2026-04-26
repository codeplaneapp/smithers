import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownPromptCache } from "./MarkdownPromptCache";
import type { CachedPrompt } from "./PromptCache";

function fixture(overrides: Partial<CachedPrompt> = {}): CachedPrompt {
  return {
    key: "demo:fixture",
    prompt: "You are a helpful assistant. Do X. Return JSON.",
    structured: { role: "assistant", task: "Do X" },
    schema: "rctf",
    stakes: "low",
    score: 0.85,
    scoreReason: "Most slots filled",
    createdAt: "2026-04-25T00:00:00.000Z",
    source: "extracted",
    overridden: false,
    ...overrides,
  };
}

describe("MarkdownPromptCache", () => {
  let root: string;
  let cache: MarkdownPromptCache;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prompt-cache-"));
    cache = new MarkdownPromptCache({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("roundtrips a cached prompt (async)", async () => {
    const value = fixture();
    await cache.set("demo:fixture", value);
    const got = await cache.get("demo:fixture");
    expect(got).toEqual(value);
  });

  test("roundtrips a cached prompt (sync)", () => {
    const value = fixture({ key: "sync:one" });
    cache.setSync("sync:one", value);
    const got = cache.getSync("sync:one");
    expect(got).toEqual(value);
  });

  test("returns undefined for a missing key", async () => {
    expect(await cache.get("does-not-exist")).toBeUndefined();
    expect(cache.getSync("does-not-exist")).toBeUndefined();
  });

  test("preserves multi-line prompt body (trailing newline normalized)", async () => {
    const value = fixture({ prompt: "Line one\nLine two\nLine three" });
    await cache.set("multiline", value);
    const got = await cache.get("multiline");
    expect(got?.prompt).toBe("Line one\nLine two\nLine three");
  });

  test("preserves quoted strings in fields", async () => {
    const value = fixture({
      scoreReason: 'Has a "quote" and a colon: yes',
      prompt: "p",
    });
    await cache.set("quoted", value);
    const got = await cache.get("quoted");
    expect(got?.scoreReason).toBe('Has a "quote" and a colon: yes');
  });

  test("delete removes the file", async () => {
    await cache.set("k", fixture({ key: "k" }));
    expect(await cache.get("k")).toBeDefined();
    await cache.delete("k");
    expect(await cache.get("k")).toBeUndefined();
  });

  test("keys lists all stored entries", async () => {
    await cache.set("a", fixture({ key: "a" }));
    await cache.set("b", fixture({ key: "b" }));
    const keys = await cache.keys();
    expect(keys.sort()).toEqual(["a", "b"]);
  });

  test("slugifies unsafe keys without losing roundtrip semantics", async () => {
    const value = fixture({ key: "Some/Weird Key!!" });
    await cache.set("Some/Weird Key!!", value);
    const got = await cache.get("Some/Weird Key!!");
    expect(got?.key).toBe("Some/Weird Key!!");
  });
});
