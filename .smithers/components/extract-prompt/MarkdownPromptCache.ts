import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
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
    const current = this.newPathFor(key);
    if (existsSync(current)) return normalizeKey(parse(await readFile(current, "utf8"), key), key);
    const legacy = this.legacyPathFor(key);
    if (legacy && existsSync(legacy)) {
      const raw = await readFile(legacy, "utf8");
      if (ownsLegacy(raw, key, legacyKeyFromFile(basename(legacy)))) {
        const value = normalizeKey(parse(raw, key), key);
        await writeFile(current, serialize(value), "utf8");
        await rm(legacy, { force: true });
        return value;
      }
    }
    return undefined;
  }

  async set(key: string, value: CachedPrompt): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const path = this.newPathFor(key);
    await writeFile(path, serialize({ ...value, key }), "utf8");
    const legacy = this.legacyPathFor(key);
    if (
      legacy &&
      legacy !== path &&
      existsSync(legacy) &&
      ownsLegacy(await readFile(legacy, "utf8"), key, legacyKeyFromFile(basename(legacy)))
    ) {
      await rm(legacy, { force: true });
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.newPathFor(key), { force: true });
    const legacy = this.legacyPathFor(key);
    if (
      legacy &&
      existsSync(legacy) &&
      ownsLegacy(await readFile(legacy, "utf8"), key, legacyKeyFromFile(basename(legacy)))
    ) {
      await rm(legacy, { force: true });
    }
  }

  async keys(): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    const entries = await readdir(this.root);
    const keys = new Set<string>();
    for (const file of entries.filter((f) => f.endsWith(".md"))) {
      const parsed = parse(await readFile(join(this.root, file), "utf8"), legacyKeyFromFile(file));
      keys.add(parsed.key);
    }
    return [...keys].sort();
  }

  /** Sync variant for use inside the (sync) smithers() build function. */
  getSync(key: string): CachedPrompt | undefined {
    const current = this.newPathFor(key);
    if (existsSync(current)) return normalizeKey(parse(readFileSync(current, "utf8"), key), key);
    const legacy = this.legacyPathFor(key);
    if (legacy && existsSync(legacy)) {
      const raw = readFileSync(legacy, "utf8");
      if (ownsLegacy(raw, key, legacyKeyFromFile(basename(legacy)))) {
        const value = normalizeKey(parse(raw, key), key);
        writeFileSync(current, serialize(value), "utf8");
        rmSync(legacy, { force: true });
        return value;
      }
    }
    return undefined;
  }

  /** Sync variant for use inside the (sync) smithers() build function. */
  setSync(key: string, value: CachedPrompt): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
    const path = this.newPathFor(key);
    writeFileSync(path, serialize({ ...value, key }), "utf8");
    const legacy = this.legacyPathFor(key);
    if (
      legacy &&
      legacy !== path &&
      existsSync(legacy) &&
      ownsLegacy(readFileSync(legacy, "utf8"), key, legacyKeyFromFile(basename(legacy)))
    ) {
      rmSync(legacy, { force: true });
    }
  }

  /** Sync variant. */
  deleteSync(key: string): void {
    rmSync(this.newPathFor(key), { force: true });
    const legacy = this.legacyPathFor(key);
    if (
      legacy &&
      existsSync(legacy) &&
      ownsLegacy(readFileSync(legacy, "utf8"), key, legacyKeyFromFile(basename(legacy)))
    ) {
      rmSync(legacy, { force: true });
    }
  }

  /** Sync variant. */
  keysSync(): string[] {
    if (!existsSync(this.root)) return [];
    const keys = new Set<string>();
    for (const file of readdirSync(this.root).filter((f) => f.endsWith(".md"))) {
      keys.add(parse(readFileSync(join(this.root, file), "utf8"), legacyKeyFromFile(file)).key);
    }
    return [...keys].sort();
  }

  private newPathFor(key: string): string {
    return join(this.root, `${slugify(key)}-${createHash("sha256").update(key).digest("hex")}.md`);
  }

  private legacyPathFor(key: string): string | undefined {
    const slug = legacySlugify(key);
    return slug ? join(this.root, `${slug}.md`) : undefined;
  }
}

function legacySlugify(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

function slugify(key: string): string {
  const slug = legacySlugify(key) || "prompt";
  return slug.slice(0, 120);
}

function legacyKeyFromFile(file: string): string {
  return file.slice(0, -".md".length);
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
    `overrideReason: ${yamlString(v.overrideReason ?? null)}`,
    `structured: ${JSON.stringify(v.structured)}`,
  ].join("\n");
  return `${FRONTMATTER_FENCE}\n${fm}\n${FRONTMATTER_FENCE}\n${BODY_FENCE}\n${v.prompt}\n`;
}

function yamlString(s: string | null): string {
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
  if (i >= lines.length) {
    throw new Error(`MarkdownPromptCache: missing closing frontmatter for key=${key}`);
  }
  i++;
  if (lines[i] === BODY_FENCE) i++;
  const prompt = lines.slice(i).join("\n").replace(/\n$/, "");

  const overrideReasonParsed =
    fm.overrideReason === undefined || fm.overrideReason === "null" ? null : parseString(fm.overrideReason, "");

  return {
    key: parseString(fm.key, key),
    schema: (fm.schema as CachedPrompt["schema"]) ?? "freeform",
    stakes: (fm.stakes as CachedPrompt["stakes"]) ?? "low",
    score: Number(fm.score ?? 0),
    scoreReason: parseString(fm.scoreReason, ""),
    createdAt: fm.createdAt ?? new Date(0).toISOString(),
    source: (fm.source as CachedPrompt["source"]) ?? "extracted",
    overridden: fm.overridden === "true",
    overrideReason: overrideReasonParsed,
    structured: fm.structured ? JSON.parse(fm.structured) : {},
    prompt,
  };
}

function normalizeKey(value: CachedPrompt, key: string): CachedPrompt {
  return { ...value, key };
}

function ownsLegacy(raw: string, requestedKey: string, legacyKey: string): boolean {
  const parsed = parse(raw, legacyKey);
  return parsed.key === requestedKey && (hasEmbeddedKey(raw) || legacyKey === requestedKey);
}

function hasEmbeddedKey(raw: string): boolean {
  return raw.split("\n").some((line) => /^\s*key\s*:/.test(line));
}

function parseString(v: string | undefined, fallback: string = ""): string {
  if (v === undefined || v === "null") return fallback;
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}
