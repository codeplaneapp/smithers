import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MarkdownPromptCache,
  MemoryPromptCache,
  SqlitePromptCache,
  rctfCompletenessScorer,
  rctfPromptSchema,
  readLatestScore,
  stakesToThreshold,
} from "../components/extract-prompt/index";
import type { CachedPrompt, PromptCache } from "../components/extract-prompt/index";
import * as barrel from "../components/extract-prompt/index";

const roots: string[] = [];
const repoRoot = join(import.meta.dir, "../..");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function markdownPath(root: string, key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "prompt";
  return join(root, `${slug}-${createHash("sha256").update(key).digest("hex")}.md`);
}

function markdownBytes(v: CachedPrompt): string {
  return `---\nkey: ${JSON.stringify(v.key)}\nschema: ${v.schema}\nstakes: ${v.stakes}\nscore: ${v.score}\nscoreReason: ${JSON.stringify(v.scoreReason)}\ncreatedAt: ${v.createdAt}\nsource: ${v.source}\noverridden: ${v.overridden}\noverrideReason: ${JSON.stringify(v.overrideReason ?? null)}\nstructured: ${JSON.stringify(v.structured)}\n---\n<!-- prompt -->\n${v.prompt}\n`;
}

const value: CachedPrompt = {
  key: "prompt/key",
  prompt: "Line one\nLine two with a \"quote\".",
  structured: { role: "analyst", constraints: ["be concise"] },
  schema: "rctf",
  stakes: "high",
  score: 0.75,
  scoreReason: "Has a \"quoted\" reason: yes",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: "manual",
  overridden: true,
  overrideReason: "test override",
};

async function cacheContract(cache: PromptCache): Promise<void> {
  expect(await cache.get("missing")).toBeUndefined();
  const logicalKey = "logical/key";
  await cache.set(logicalKey, { ...value, key: "embedded/key" });
  expect(await cache.get(logicalKey)).toEqual({ ...value, key: logicalKey });
  const updated = { ...value, score: 1, scoreReason: "updated" };
  await cache.set(logicalKey, { ...updated, key: "another/embedded/key" });
  expect(await cache.get(logicalKey)).toEqual({ ...updated, key: logicalKey });
  expect(await cache.keys?.()).toHaveLength(1);
  await cache.delete(logicalKey);
  expect(await cache.get(logicalKey)).toBeUndefined();
  expect(await cache.keys?.()).toEqual([]);
}

describe("init-pack prompt caches", () => {
  test("markdown cache covers logical keys, legacy files, defaults, and sync/async safety", async () => {
    const root = tempRoot("markdown-helper-");
    try {
      const cache = new MarkdownPromptCache({ root });
      const absent = new MarkdownPromptCache({ root: join(root, "absent") });
      await cacheContract(cache);
      expect(await absent.get("missing")).toBeUndefined();
      expect(await absent.keys()).toEqual([]);
      await absent.delete("missing");
      expect(absent.getSync("missing")).toBeUndefined();
      expect(absent.keysSync()).toEqual([]);
      absent.deleteSync("missing");
      // Missing/null normalize to null; authored strings round-trip exactly.
      await cache.set("no-override", { ...value, key: "no-override", overridden: true, overrideReason: undefined });
      expect((await cache.get("no-override"))?.overrideReason).toBeNull();
      await cache.set("null-override", { ...value, key: "null-override", overridden: true, overrideReason: null });
      expect((await cache.get("null-override"))?.overrideReason).toBeNull();
      await cache.set("empty-override", { ...value, key: "empty-override", overridden: true, overrideReason: "" });
      expect((await cache.get("empty-override"))?.overrideReason).toBe("");
      await cache.set("real-override", { ...value, key: "real-override", overridden: true, overrideReason: "human approved" });
      expect((await cache.get("real-override"))?.overrideReason).toBe("human approved");
      cache.deleteSync("no-override");
      cache.deleteSync("null-override");
      cache.deleteSync("empty-override");
      cache.deleteSync("real-override");
      writeFileSync(join(root, "manual.md"), `---\nkey: manual\nschema: rctf\nstakes: high\nscore: 0.8\nscoreReason: manually authored\ncreatedAt: 2026-01-02T00:00:00.000Z\nsource: manual\noverridden: false\nstructured: {"role":"editor"}\n---\n<!-- prompt -->\nWrite a careful memo.\n`);
      expect(await cache.get("manual")).toEqual({ key: "manual", prompt: "Write a careful memo.", structured: { role: "editor" }, schema: "rctf", stakes: "high", score: 0.8, scoreReason: "manually authored", createdAt: "2026-01-02T00:00:00.000Z", source: "manual", overridden: false, overrideReason: null });
      writeFileSync(join(root, "minimal.md"), `---\n---\nminimal body\n`);
      expect(await cache.get("minimal")).toMatchObject({ key: "minimal", schema: "freeform", stakes: "low", score: 0, scoreReason: "", createdAt: "1970-01-01T00:00:00.000Z", source: "extracted", overridden: false, overrideReason: null, structured: {}, prompt: "minimal body" });
      writeFileSync(join(root, "a-b.md"), `---\n---\nlegacy collision\n`);
      const legacyBytes = readFileSync(join(root, "a-b.md"), "utf8");
      const collisionValue = { ...value, key: "ignored", prompt: "collision" };
      expect(await cache.get("A B")).toBeUndefined();
      expect(readFileSync(join(root, "a-b.md"), "utf8")).toBe(legacyBytes);
      await cache.set("A B", collisionValue);
      expect(existsSync(join(root, "a-b.md"))).toBe(true);
      expect(readFileSync(join(root, "a-b.md"), "utf8")).toBe(legacyBytes);
      expect(readFileSync(markdownPath(root, "A B"), "utf8")).toBe(markdownBytes({ ...collisionValue, key: "A B" }));
      await cache.delete("A B");
      expect(existsSync(join(root, "a-b.md"))).toBe(true);
      expect(readFileSync(join(root, "a-b.md"), "utf8")).toBe(legacyBytes);
      writeFileSync(join(root, "a-b.md"), `---\n  key: "A B"\n---\nexplicit owner\n`);
      expect(await cache.get("a-b")).toBeUndefined();
      expect(await cache.get("A B")).toEqual(expect.objectContaining({ key: "A B", prompt: "explicit owner" }));
      expect(existsSync(join(root, "a-b.md"))).toBe(false);
      await cache.delete("A B");
      const ownerLegacy = `---\n---\nowner legacy\n`;
      writeFileSync(join(root, "a-b.md"), ownerLegacy);
      expect(await cache.get("a-b")).toMatchObject({ key: "a-b", prompt: "owner legacy" });
      expect(readFileSync(markdownPath(root, "a-b"), "utf8")).toBe(markdownBytes({ ...value, key: "a-b", prompt: "owner legacy", structured: {}, schema: "freeform", stakes: "low", score: 0, scoreReason: "", createdAt: "1970-01-01T00:00:00.000Z", source: "extracted", overridden: false, overrideReason: undefined }));
      expect(existsSync(join(root, "a-b.md"))).toBe(false);
      writeFileSync(join(root, "a-b.md"), `---\n---\ntrue owner update\n`);
      await cache.set("a-b", { ...value, key: "wrong", prompt: "updated owner" });
      expect(existsSync(join(root, "a-b.md"))).toBe(false);
      expect(readFileSync(markdownPath(root, "a-b"), "utf8")).toBe(markdownBytes({ ...value, key: "a-b", prompt: "updated owner" }));
      await cache.delete("a-b");
      expect(existsSync(markdownPath(root, "a-b"))).toBe(false);
      writeFileSync(join(root, "a-b.md"), `---\n---\nasync owner\n`);
      expect(await cache.get("A B")).toBeUndefined();
      expect(existsSync(join(root, "a-b.md"))).toBe(true);
      expect(await cache.get("a-b")).toMatchObject({ key: "a-b", prompt: "async owner" });
      await cache.delete("a-b");
      writeFileSync(join(root, "a-b.md"), `---\n---\nsync owner\n`);
      expect(cache.getSync("A B")).toBeUndefined();
      expect(existsSync(join(root, "a-b.md"))).toBe(true);
      expect(cache.getSync("a-b")).toMatchObject({ key: "a-b", prompt: "sync owner" });
      writeFileSync(join(root, "a-b.md"), `---\n---\nsync collision\n`);
      cache.setSync("A B", collisionValue);
      expect(readFileSync(join(root, "a-b.md"), "utf8")).toContain("sync collision");
      cache.deleteSync("A B");
      expect(existsSync(join(root, "a-b.md"))).toBe(true);
      cache.deleteSync("a-b");
      expect(existsSync(join(root, "a-b.md"))).toBe(false);
      await cache.set("Some/Unsafe Key!!", { ...value, key: "wrong" });
      expect(await cache.get("Some/Unsafe Key!!")).toEqual({ ...value, key: "Some/Unsafe Key!!" });
      expect(await cache.get("A B")).toBeUndefined();
      await cache.set("A B", { ...value, key: "first" });
      await cache.delete("A B");
      expect(existsSync(join(root, "a-b.md"))).toBe(false);
      expect(await cache.get("a-b")).toBeUndefined();
      await cache.set("A B", { ...value, key: "first" });
      await cache.set("a-b", { ...value, key: "second", prompt: "second" });
      await cache.set("!!!", { ...value, key: "third", prompt: "punctuation" });
      expect(await cache.get("A B")).toMatchObject({ key: "A B", prompt: value.prompt });
      expect(await cache.get("a-b")).toMatchObject({ key: "a-b", prompt: "second" });
      expect(await cache.get("!!!")).toMatchObject({ key: "!!!", prompt: "punctuation" });
      expect(await cache.keys()).toEqual(["!!!", "A B", "Some/Unsafe Key!!", "a-b", "manual", "minimal"]);
      await cache.delete("A B");
      expect(await cache.get("A B")).toBeUndefined();
      expect(await cache.get("a-b")).toBeDefined();
      await cache.delete("a-b");
      await cache.delete("!!!");
      writeFileSync(join(root, ".md"), `---\nkey: unrelated\n---\nbare\n`);
      await cache.set("!!!", { ...value, key: "third", prompt: "punctuation" });
      await cache.delete("!!!");
      expect(existsSync(join(root, ".md"))).toBe(true);
      expect(cache.getSync("Some/Unsafe Key!!")).toEqual({ ...value, key: "Some/Unsafe Key!!" });
      cache.setSync("sync/value", { ...value, key: "not-the-caller", prompt: "sync\ntrailing\n" });
      expect(cache.getSync("sync/value")).toMatchObject({ key: "sync/value", prompt: "sync\ntrailing\n" });
      writeFileSync(join(root, "sync-legacy.md"), `---\n---\nsync legacy\n`);
      expect(cache.getSync("sync-legacy")).toMatchObject({ key: "sync-legacy", prompt: "sync legacy" });
      expect(existsSync(join(root, "sync-legacy.md"))).toBe(false);
      expect(cache.keysSync()).toEqual(["Some/Unsafe Key!!", "manual", "minimal", "sync-legacy", "sync/value", "unrelated"]);
      cache.deleteSync("sync/value");
      cache.deleteSync("sync-legacy");
      expect(cache.keysSync()).toEqual(["Some/Unsafe Key!!", "manual", "minimal", "unrelated"]);
      writeFileSync(join(root, "bad-open.md"), "not frontmatter\n");
      expect(() => cache.keysSync()).toThrow(/missing frontmatter/);
      rmSync(join(root, "bad-open.md"));
      writeFileSync(join(root, "bad-close.md"), "---\nkey: bad-close\n");
      expect(() => cache.getSync("bad-close")).toThrow(/missing closing frontmatter/);
      rmSync(join(root, "bad-close.md"));
      writeFileSync(join(root, "bad-json.md"), "---\nkey: bad-json\nstructured: {bad\n---\nbody\n");
      expect(() => cache.getSync("bad-json")).toThrow();
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });

  test("memory cache implements roundtrip, missing, update/delete, and key enumeration", async () => {
    const cache = new MemoryPromptCache();
    await cacheContract(cache);
    await cache.set("a", { ...value, key: "a" });
    await cache.set("b", { ...value, key: "b" });
    expect((await cache.keys()).sort()).toEqual(["a", "b"]);
  });

});

describe("init-pack sqlite prompt cache", () => {
  test("uses real isolated databases with safe tables, ordering, persistence, and lifecycle", async () => {
    const root = tempRoot("sqlite-helper-");
    const path = join(root, "nested", "prompts.db");
    const defaultPath = join(root, "default.db");
    let cache: SqlitePromptCache | undefined;
    let reopened: SqlitePromptCache | undefined;
    let defaultCache: SqlitePromptCache | undefined;
    let db: Database | undefined;
    try {
      defaultCache = new SqlitePromptCache({ path: defaultPath });
      expect(await defaultCache.get("missing")).toBeUndefined();
      db = new Database(defaultPath, { readonly: true });
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extract_prompt_cache'").get()).toEqual({ name: "extract_prompt_cache" });
      db.close(); db = undefined;
      defaultCache.close();
      defaultCache.close();
      const invalidRoot = join(root, "must-not-exist");
      expect(() => new SqlitePromptCache({ path: join(invalidRoot, "bad.db"), table: "bad-name" })).toThrow(/invalid table name/);
      expect(() => new SqlitePromptCache({ path: join(invalidRoot, "bad.db"), table: "1bad" })).toThrow(/invalid table name/);
      expect(() => new SqlitePromptCache({ path: join(invalidRoot, "bad.db"), table: "x; DROP TABLE cache" })).toThrow(/invalid table name/);
      expect(existsSync(invalidRoot)).toBe(false);
      cache = new SqlitePromptCache({ path, table: "custom_prompts" });
      expect(await cache.get("missing")).toBeUndefined();
      await cacheContract(cache);
      mkdirSync(join(root, "nested"), { recursive: true });
      db = new Database(path);
      db.run("INSERT INTO custom_prompts (key, json, created_at_ms) VALUES (?, ?, ?)", ["stored-key", JSON.stringify({ ...value, key: "embedded-key" }), 1]);
      db.close(); db = undefined;
      expect(await cache.get("stored-key")).toEqual({ ...value, key: "stored-key" });
      expect(await cache.keys()).toEqual(["stored-key"]);
      const reserved = new SqlitePromptCache({ path, table: "select" });
      await reserved.set("reserved-key", { ...value, key: "embedded" });
      expect(await reserved.get("reserved-key")).toEqual({ ...value, key: "reserved-key" });
      expect(await reserved.keys()).toEqual(["reserved-key"]);
      reserved.close();
      await cache.delete("never-existed");
      await cache.set("a", { ...value, key: "a" });
      await cache.set("b", { ...value, key: "b" });
      await cache.set("A", { ...value, key: "A" });
      expect(await cache.keys()).toEqual(["A", "a", "b", "stored-key"]);
      await cache.set("a", { ...value, key: "a", score: 0, source: "extracted" });
      expect(await cache.get("a")).toEqual({ ...value, key: "a", score: 0, source: "extracted" });
      await cache.delete("b");
      expect(await cache.get("b")).toBeUndefined();
      cache.close();
      cache.close();
      reopened = new SqlitePromptCache({ path, table: "custom_prompts" });
      expect(await reopened.get("a")).toEqual({ ...value, key: "a", score: 0, source: "extracted" });
      expect(await reopened.keys()).toEqual(["A", "a", "stored-key"]);
      reopened.close();
      reopened.close();
      db = new Database(path, { readonly: true });
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_prompts'").get()).toEqual({ name: "custom_prompts" });
      db.close(); db = undefined;
      const corrupt = new Database(path);
      corrupt.run("INSERT OR REPLACE INTO custom_prompts (key, json, created_at_ms) VALUES (?, ?, ?)", ["corrupt", "{not-json", Date.now()]);
      corrupt.close();
      const corruptCache = new SqlitePromptCache({ path, table: "custom_prompts" });
      await expect(corruptCache.get("corrupt")).rejects.toThrow();
      corruptCache.close();
    } finally { cache?.close(); reopened?.close(); defaultCache?.close(); db?.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
});

describe("RCTF scorer and schema", () => {
  const output = { prompt: "You are a CFO. Draft a board memo.", structured: { role: "CFO", task: "draft a board memo" } };
  const judge = (response: unknown) => ({ generate: async ({ prompt }: { prompt: string }) => response ?? prompt });

  test("scorer has defaults, propagates prompt, parses real judge output, and handles response boundaries", async () => {
    let promptSeen = "";
    const scorer = rctfCompletenessScorer({ judge: { generate: async ({ prompt }) => { promptSeen = prompt; return { text: '{"score":0.92,"reason":"complete"}' }; } } });
    expect(scorer.id).toBe("rctf-completeness");
    expect(scorer.name).toBe("R-C-T-F Completeness");
    expect(scorer.description).toBe("Rates an extracted prompt by how completely it fills Role, Context, Task, Format.");
    expect(await scorer.score({ input: "", output })).toEqual(expect.objectContaining({ score: 0.92, reason: "complete" }));
    expect(promptSeen).toContain('"role": "CFO"');

    for (const [response, score] of [
      ['{"score":0,"reason":"none"}', 0],
      ['{"score":1,"reason":"all"}', 1],
      ['{"score":2.5,"reason":"high"}', 1],
      ['{"score":-0.5,"reason":"low"}', 0],
    ] as const) expect((await rctfCompletenessScorer({ judge: judge(response) }).score({ input: "", output })).score).toBe(score);
    expect((await rctfCompletenessScorer({ judge: judge('{"score":0.5,"reason":"plain"}') }).score({ input: "", output })).score).toBe(0.5);
    expect((await rctfCompletenessScorer({ judge: judge('prose {"score":0.7,"reason":"extra"} more') }).score({ input: "", output })).reason).toBe("extra");
    expect((await rctfCompletenessScorer({ id: "custom-id", name: "Custom name", description: "Custom description", judge: judge("not json") }).score({ input: "", output })).score).toBe(0);
    expect((await rctfCompletenessScorer({ judge: judge("") }).score({ input: "", output })).score).toBe(0);
    expect((await rctfCompletenessScorer({ judge: judge('{"score":"nope","reason":"not numeric"}') }).score({ input: "", output }))).toEqual(expect.objectContaining({ score: 0, reason: "not numeric" }));
    expect((await rctfCompletenessScorer({ judge: judge({ score: Number.NaN, reason: "nan" }) }).score({ input: "", output })).score).toBe(0);
    const rejection = new Error("judge unavailable");
    await expect(rctfCompletenessScorer({ judge: { generate: async () => { throw rejection; } } }).score({ input: "", output })).rejects.toBe(rejection);
  });

  test("judge boundary preserves wrapper metadata and string/object prompt templates", async () => {
    const prompts: string[] = [];
    const scorer = rctfCompletenessScorer({ id: "custom-id", name: "Custom name", description: "Custom description", judge: { generate: async ({ prompt }) => { prompts.push(prompt); return '{"score":0.6,"reason":"ok"}'; } } });
    expect(scorer).toMatchObject({ id: "custom-id", name: "Custom name", description: "Custom description" });
    await scorer.score({ input: "", output: "plain text" });
    await scorer.score({ input: "", output: { role: "structured" } });
    expect(prompts[0]).toContain("plain text");
    expect(prompts[1]).toContain('"role": "structured"');
  });

  test("schema applies defaults and rejects invalid enum, required fields, and score boundaries", () => {
    const parsed = rctfPromptSchema.parse({ prompt: "p", structured: {}, score: 0, scoreReason: "" });
    expect(parsed.structured).toEqual({ role: "", context: "", task: "", format: "", constraints: [], successCriteria: [], outOfScope: [] });
    expect(parsed.nextPrinciple).toBe("none");
    expect(parsed.nextQuestion).toBe("");
    expect(parsed.resolved).toBe(false);
    expect(parsed.overridden).toBe(false);
    expect(parsed.overrideReason).toBeNull();
    expect(rctfPromptSchema.parse({ prompt: "p", structured: {}, score: 0.5, scoreReason: "", nextQuestion: "q", resolved: true, overridden: true, overrideReason: "ship it" })).toMatchObject({ nextQuestion: "q", resolved: true, overridden: true, overrideReason: "ship it" });
    const principles = ["definition", "elenchus", "hypothesis-elimination", "generalization", "induction", "dialectic", "maieutic", "analogy", "irony", "recollection", "none"] as const;
    for (const nextPrinciple of principles) expect(rctfPromptSchema.safeParse({ prompt: "p", structured: {}, score: 1, scoreReason: "", nextPrinciple }).success).toBe(true);
    expect(rctfPromptSchema.safeParse({ prompt: "p", structured: {}, score: 1.1, scoreReason: "" }).success).toBe(false);
    expect(rctfPromptSchema.safeParse({ prompt: "p", structured: {}, score: -0.1, scoreReason: "" }).success).toBe(false);
    expect(rctfPromptSchema.safeParse({ prompt: "p", structured: {}, score: 0, scoreReason: "", nextPrinciple: "invalid" }).success).toBe(false);
    for (const [overridden, overrideReason, valid] of [[true, null, false], [true, "", false], [true, "  \n", false], [false, null, true], [false, "", true]] as const) {
      expect(rctfPromptSchema.safeParse({ prompt: "p", structured: {}, score: 0, scoreReason: "", overridden, overrideReason }).success).toBe(valid);
    }
    expect(rctfPromptSchema.safeParse({ structured: {}, score: 0, scoreReason: "" }).success).toBe(false);
    expect(rctfPromptSchema.safeParse({ prompt: "p", structured: {}, score: 0, scoreReason: "" }).success).toBe(true);
  });
});

describe("score and stakes helpers", () => {
  test("readLatestScore reads real SQLite rows with exact latest, iteration, missing, pending, and boundary behavior", async () => {
    const root = tempRoot("score-helper-");
    const missingRoot = tempRoot("missing-score-");
    const path = join(root, "scores.db");
    let db: Database | undefined;
    try {
      db = new Database(path);
      db.run("CREATE TABLE _smithers_scorers (run_id TEXT, node_id TEXT, scorer_name TEXT, iteration INTEGER, score REAL, reason TEXT, scored_at_ms INTEGER)");
      db.run("INSERT INTO _smithers_scorers VALUES ('wrong-run','n','s',1,.99,'wrong run',900),('r','wrong-node','s',1,.98,'wrong node',800),('r','n','s',0,0,'zero',100),('r','n','s',0,1,NULL,200),('r','n','s',1,.25,'iter',300)");
      db.close(); db = undefined;
      expect(await readLatestScore({ runId: "r", nodeId: "n", scorerName: "s", dbPath: path })).toEqual({ status: "ready", score: .25, reason: "iter", scoredAtMs: 300 });
      expect(await readLatestScore({ runId: "r", nodeId: "n", scorerName: "s", iteration: 0, dbPath: path })).toEqual({ status: "ready", score: 1, reason: null, scoredAtMs: 200 });
      expect(await readLatestScore({ runId: "r", nodeId: "n", scorerName: "s", iteration: 1, dbPath: path })).toEqual({ status: "ready", score: .25, reason: "iter", scoredAtMs: 300 });
      expect(await readLatestScore({ runId: "r", nodeId: "n", scorerName: "other", dbPath: path })).toEqual({ status: "pending" });
      expect(await readLatestScore({ runId: "r", nodeId: "n", scorerName: "s", iteration: 2, dbPath: path })).toEqual({ status: "pending" });
      expect(await readLatestScore({ runId: "r", nodeId: "n", scorerName: "s", dbPath: join(missingRoot, "none.db") })).toEqual({ status: "missing" });
    } finally { db?.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); rmSync(missingRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });

  test("stakes map every public value to its documented threshold", () => {
    expect(stakesToThreshold("high")).toBe(1);
    expect(stakesToThreshold("low")).toBe(0.7);
  });
});

describe("extract-prompt barrel and roles", () => {
  test("barrel exposes the exact runtime exports and a usable type-facing cache contract", async () => {
    expect(Object.keys(barrel).sort()).toEqual(["ExtractPrompt", "MarkdownPromptCache", "MemoryPromptCache", "SqlitePromptCache", "rctfCompletenessScorer", "rctfPromptSchema", "readLatestScore", "stakesToThreshold"]);
    expect(barrel.MarkdownPromptCache).toBe(MarkdownPromptCache);
    expect(barrel.MemoryPromptCache).toBe(MemoryPromptCache);
    expect(barrel.SqlitePromptCache).toBe(SqlitePromptCache);
    expect(barrel.rctfPromptSchema).toBe(rctfPromptSchema);
    const cache: PromptCache = new MemoryPromptCache();
    await cache.set("typed", value);
    expect((await cache.get("typed"))?.key).toBe("typed");
  });

  test("roles are deterministic with isolated homes, paths, and model overrides", async () => {
    const root = tempRoot("roles-helper-");
    const fakeBin = join(root, "bin");
      const script = `
      await import(${JSON.stringify(join(repoRoot, ".smithers/preload.ts"))});
      const roles = await import(${JSON.stringify(join(repoRoot, ".smithers/components/roles.ts"))} + "?case=" + process.env.SMITHERS_ROLE_CASE);
      const describe = (chain) => chain.map((agent) => { const opts = agent.opts ?? { env: agent.env }; return { type: agent.constructor.name, model: agent.model, opts: { configDir: opts.configDir, apiKey: opts.apiKey ? "<redacted>" : undefined, env: opts.env ? { PATH: opts.env.PATH, SMITHERS_ROLE_SENTINEL: opts.env.SMITHERS_ROLE_SENTINEL } : undefined } }; });
      console.log(JSON.stringify({ models: [roles.SOL_MODEL, roles.TERRA_MODEL, roles.IMPLEMENTER_MODEL], implementer: describe(roles.implementer), validator: describe(roles.validator), synthesizer: describe(roles.synthesizer), fableAuthor: describe(roles.fableAuthor), polishReviewer: describe(roles.polishReviewer), panelists: roles.panelists.map(describe) }));
    `;
    const liveChildren = new Set<ReturnType<typeof spawn>>();
    const run = (env: NodeJS.ProcessEnv) => new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
      liveChildren.add(child);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); liveChildren.delete(child); reject(error); });
      child.on("close", (status) => {
        clearTimeout(timer);
        liveChildren.delete(child);
        try {
          if (timedOut) throw new Error("roles child timed out");
          if (status !== 0) throw new Error(`roles child exited ${status}: ${stderr}\n${stdout}`);
          const line = stdout.trim().split("\n").at(-1);
          expect(line).toBeDefined();
          resolve(JSON.parse(line!));
        } catch (error) { reject(error); }
      });
    });
    async function killLiveChildren(): Promise<void> {
      const survivors = [...liveChildren];
      await Promise.all(survivors.map((child) => new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once("close", () => resolve());
        child.kill("SIGKILL");
      })));
    }
    try {
      mkdirSync(fakeBin, { recursive: true });
      const cliName = (name: string) => process.platform === "win32" ? `${name}.CMD` : name;
      for (const name of ["claude", "kimi"]) {
        const path = join(root, "bin", cliName(name));
        writeFileSync(path, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
        if (process.platform !== "win32") chmodSync(path, 0o755);
      }
      // Minimal allowlisted env: explicit keys only, never the inherited
      // process.env (which may carry host secrets like API keys/tokens).
      const clean = (suffix: string): NodeJS.ProcessEnv => {
        const home = join(root, `home-${suffix}`);
        const userProfile = join(root, `profile-${suffix}`);
        const smithersHome = join(root, `smithers-${suffix}`);
        const tmpdir = join(root, `tmpdir-${suffix}`);
        const temp = join(root, `temp-${suffix}`);
        const tmp = join(root, `tmp-${suffix}`);
        for (const dir of [home, userProfile, smithersHome, tmpdir, temp, tmp]) mkdirSync(dir, { recursive: true });
        return {
          HOME: home, USERPROFILE: userProfile, SMITHERS_HOME: smithersHome,
          TMPDIR: tmpdir, TEMP: temp, TMP: tmp,
          SMITHERS_TEST_AGENT_PATH: fakeBin, PATH: fakeBin, SMITHERS_CODEX_PAUSED: "0", SMITHERS_ROLE_CASE: suffix,
          SMITHERS_SOL_MODEL: "", SMITHERS_TERRA_MODEL: "", SMITHERS_IMPLEMENTER_MODEL: "", MODEL: "", SMITHERS_ROLE_SENTINEL: "preserved",
          ...(process.platform === "win32" ? {
            SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
            WINDIR: process.env.WINDIR ?? "C:\\Windows",
            PATHEXT: ".CMD;.EXE;.BAT",
          } : {}),
        };
      };
      const activeEnv = clean("active");
      const fallbackEnv = clean("fallback");
      writeFileSync(join(activeEnv.SMITHERS_HOME!, "accounts.json"), JSON.stringify({ accounts: [
        { provider: "codex", configDir: join(root, "codex-terra") },
        { provider: "codex", configDir: join(root, "codex-sol") },
        { provider: "openai-api", apiKey: "test-openai-key" },
      ] }));
      Object.assign(activeEnv, { SMITHERS_SOL_MODEL: "active-sol", SMITHERS_TERRA_MODEL: "active-terra", SMITHERS_IMPLEMENTER_MODEL: "active-luna" });
      Object.assign(fallbackEnv, { SMITHERS_CODEX_PAUSED: "1", SMITHERS_SOL_MODEL: "sol-override", SMITHERS_TERRA_MODEL: "terra-override", SMITHERS_IMPLEMENTER_MODEL: "luna-override" });
      const noCliEnv = clean("nocli");
      Object.assign(noCliEnv, { SMITHERS_TEST_AGENT_PATH: "", PATH: "", SMITHERS_CODEX_PAUSED: "0" });
      // Sequential, not concurrent: each child's stdout/stderr streams are
      // fully drained to EOF and its process reaped ("close") before the next
      // spawns, so this suite never piles up dozens of live subprocesses/fds
      // at once (the prior run's system-wide ENFILE root cause).
      const noCli = await run(noCliEnv);
      const active = await run(activeEnv);
      const fallback = await run(fallbackEnv);
      expect(noCli.models).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-terra"]);
      expect(noCli.implementer).toEqual([{ type: "CodexAgent", model: "gpt-5.6-terra", opts: { configDir: undefined, env: undefined } }]);
      expect(noCli.validator).toEqual([{ type: "CodexAgent", model: "gpt-5.6-terra", opts: { configDir: undefined, env: undefined } }]);
      expect(noCli.synthesizer).toEqual([{ type: "CodexAgent", model: "gpt-5.6-sol", opts: { configDir: undefined, env: undefined } }]);
      expect(noCli.fableAuthor).toEqual(noCli.synthesizer);
      expect(noCli.polishReviewer).toEqual(noCli.synthesizer);
      expect(noCli.panelists).toEqual([noCli.synthesizer, noCli.synthesizer]);
      expect(active.models).toEqual(["active-sol", "active-terra", "active-luna"]);
      const activeChains = [active.implementer, active.validator, active.synthesizer, active.fableAuthor, active.polishReviewer, ...active.panelists];
      const activeCodex = activeChains.flat().filter((agent) => agent.type === "CodexAgent");
      const accountDescriptors = [
        { configDir: undefined, apiKey: undefined },
        { configDir: join(root, "codex-terra"), apiKey: undefined },
        { configDir: join(root, "codex-sol"), apiKey: undefined },
        { configDir: undefined, apiKey: "<redacted>" },
      ];
      const expectedCodex = (models: string[]) => models.flatMap((model) => accountDescriptors.map((account) => ({ model, ...account })));
      expect(activeCodex.map((agent) => ({ model: agent.model, configDir: agent.opts.configDir, apiKey: agent.opts.apiKey }))).toEqual(expectedCodex([
        "active-luna", "active-terra", "active-sol", "active-sol", "active-sol", "active-sol", "active-sol",
      ]));
      expect(activeCodex.every((agent) => agent.opts.env?.SMITHERS_ROLE_SENTINEL === "preserved" && agent.opts.env?.PATH === fakeBin)).toBe(true);
      expect(activeChains.flat().filter((agent) => agent.type === "CodexAgent").map((agent) => agent.model)).toEqual([
        ...Array(4).fill("active-luna"),
        ...Array(4).fill("active-terra"),
        ...Array(20).fill("active-sol"),
      ]);
      expect(active.implementer.map((a) => a.type)).toEqual(["CodexAgent", "CodexAgent", "CodexAgent", "CodexAgent", "ClaudeCodeAgent", "ClaudeCodeAgent"]);
      expect(active.validator.map((a) => a.type)).toEqual(["CodexAgent", "CodexAgent", "CodexAgent", "CodexAgent", "ClaudeCodeAgent", "ClaudeCodeAgent"]);
      expect(active.synthesizer.map((a) => a.type)).toEqual(["CodexAgent", "CodexAgent", "CodexAgent", "CodexAgent", "ClaudeCodeAgent", "ClaudeCodeAgent"]);
      expect(active.fableAuthor.map((a) => a.type)).toEqual(["ClaudeCodeAgent", "CodexAgent", "CodexAgent", "CodexAgent", "CodexAgent", "ClaudeCodeAgent"]);
      expect(active.panelists.map((seat) => seat.map((a) => a.type))).toEqual([["CodexAgent", "CodexAgent", "CodexAgent", "CodexAgent", "ClaudeCodeAgent", "ClaudeCodeAgent"], ["CodexAgent", "CodexAgent", "CodexAgent", "CodexAgent", "ClaudeCodeAgent", "ClaudeCodeAgent"]]);
      expect(active.polishReviewer.map((a) => a.type)).toEqual(["CodexAgent", "CodexAgent", "CodexAgent", "CodexAgent", "ClaudeCodeAgent", "ClaudeCodeAgent"]);
      expect(fallback.models).toEqual(["sol-override", "terra-override", "luna-override"]);
      const fallbackAgentEnv = expect.objectContaining({ SMITHERS_ROLE_SENTINEL: "preserved", PATH: fakeBin });
      expect(fallback.implementer).toEqual([{ type: "ClaudeCodeAgent", model: "claude-sonnet-5", opts: { env: fallbackAgentEnv } }, { type: "ClaudeCodeAgent", model: "claude-fable-5", opts: { env: fallbackAgentEnv } }]);
      expect(fallback.validator).toEqual(fallback.implementer);
      const fallbackSol = [{ type: "ClaudeCodeAgent", model: "claude-fable-5", opts: { env: fallbackAgentEnv } }, { type: "ClaudeCodeAgent", model: "claude-opus-4-8", opts: { env: fallbackAgentEnv } }];
      expect(fallback.synthesizer).toEqual(fallbackSol);
      expect(fallback.fableAuthor).toEqual(fallbackSol);
      expect(fallback.polishReviewer).toEqual(fallbackSol);
      expect(fallback.panelists).toEqual([fallbackSol, fallbackSol]);
    } finally { await killLiveChildren(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, { timeout: 120_000 });
});
