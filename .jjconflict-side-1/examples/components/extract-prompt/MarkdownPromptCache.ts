import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { CachedPrompt, PromptCache } from "./PromptCache";

export type MarkdownPromptCacheOptions = {
  /** Cache root. Default: `.smithers/cache/prompts`. */
  root?: string;
};

const FRONTMATTER_FENCE = "---";
const BODY_FENCE = "<!-- prompt -->";

/**
 * On-disk prompt cache. One file per key under `root`, with YAML frontmatter
 * for the structured fields and a fenced body for the rendered prompt.
 *
 * Files are human-editable. Hand-editing is supported: set `source: manual`
 * in the frontmatter and the entry will round-trip through the cache.
 */
export class MarkdownPromptCache implements PromptCache {
  private readonly root: string;

  constructor(opts: MarkdownPromptCacheOptions = {}) {
    this.root = resolve(opts.root ?? ".smithers/cache/prompts");
  }

  async get(key: string): Promise<CachedPrompt | undefined> {
    const path = this.pathFor(key);
    if (!existsSync(path)) return undefined;
    const raw = await readFile(path, "utf8");
    return parse(raw, key);
  }

  async set(key: string, value: CachedPrompt): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const path = this.pathFor(key);
    await writeFile(path, serialize(value), "utf8");
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    if (!existsSync(path)) return;
    await rm(path, { force: true });
  }

  async keys(): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    const entries = await readdir(this.root);
    return entries
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  }

  /** Sync variant for use inside the (sync) smithers() build function. */
  getSync(key: string): CachedPrompt | undefined {
    const path = this.pathFor(key);
    if (!existsSync(path)) return undefined;
    return parse(readFileSync(path, "utf8"), key);
  }

  /** Sync variant for use inside the (sync) smithers() build function. */
  setSync(key: string, value: CachedPrompt): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
    writeFileSync(this.pathFor(key), serialize(value), "utf8");
  }

  /** Sync variant. */
  deleteSync(key: string): void {
    const path = this.pathFor(key);
    if (existsSync(path)) rmSync(path, { force: true });
  }

  /** Sync variant. */
  keysSync(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  }

  private pathFor(key: string): string {
    return join(this.root, `${slugify(key)}.md`);
  }
}

function slugify(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

function serialize(v: CachedPrompt): string {
  const fm = [
    `key: ${yamlString(v.key)}`,
    `schema: ${v.schema}`,
    `stakes: ${v.stakes}`,
    `score: ${v.score}`,
    `scoreReason: ${yamlString(v.scoreReason)}`,
    `createdAt: ${v.createdAt}`,
    `source: ${v.source}`,
    `overridden: ${v.overridden}`,
    `structured: ${JSON.stringify(v.structured)}`,
  ].join("\n");
  return `${FRONTMATTER_FENCE}\n${fm}\n${FRONTMATTER_FENCE}\n${BODY_FENCE}\n${v.prompt}\n`;
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

function parse(raw: string, key: string): CachedPrompt {
  const lines = raw.split("\n");
  if (lines[0] !== FRONTMATTER_FENCE) {
    throw new Error(`MarkdownPromptCache: missing frontmatter for key=${key}`);
  }
  let i = 1;
  const fm: Record<string, string> = {};
  while (i < lines.length && lines[i] !== FRONTMATTER_FENCE) {
    const line = lines[i]!;
    const idx = line.indexOf(":");
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      fm[k] = v;
    }
    i++;
  }
  i++;
  if (lines[i] === BODY_FENCE) i++;
  const prompt = lines.slice(i).join("\n").replace(/\n$/, "");

  return {
    key: parseString(fm.key, key),
    schema: (fm.schema as CachedPrompt["schema"]) ?? "freeform",
    stakes: (fm.stakes as CachedPrompt["stakes"]) ?? "low",
    score: Number(fm.score ?? 0),
    scoreReason: parseString(fm.scoreReason, ""),
    createdAt: fm.createdAt ?? new Date(0).toISOString(),
    source: (fm.source as CachedPrompt["source"]) ?? "extracted",
    overridden: fm.overridden === "true",
    structured: fm.structured ? JSON.parse(fm.structured) : {},
    prompt,
  };
}

function parseString(v: string | undefined, fallback: string): string {
  if (v === undefined) return fallback;
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}
