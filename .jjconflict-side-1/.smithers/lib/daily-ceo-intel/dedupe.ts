import { createHash } from "node:crypto";
import type { DedupeOutput, Item } from "./schemas";

const TRACKING_PARAMS = /^(utm_|ref$|ref_src$|igshid$|fbclid$|gclid$|mc_cid$|mc_eid$|spm$|_hs.*|mkt_tok$)/i;

export function canonicalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    const keep = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.test(key));
    url.search = "";
    for (const [key, value] of keep) url.searchParams.append(key, value);
    url.hostname = url.hostname.toLowerCase();
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    url.pathname = pathname;
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export function normalizedTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function contentHashKey(body: string): string {
  const normalized = body.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
  return createHash("sha1").update(normalized).digest("hex");
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "is", "are", "was", "were",
  "how", "what", "why", "new", "now", "your", "you", "we", "our", "it", "its", "at", "by", "from",
  "vs", "v", "into", "about", "release", "releases", "announcing", "announces", "launch", "launches",
]);

const KNOWN_BRANDS = [
  "claude", "anthropic", "openai", "gpt", "codex", "gemini", "google", "cloudflare", "vercel",
  "github", "cursor", "mcp", "langchain", "crewai", "autogen", "huggingface", "smithers",
  "copilot", "bedrock", "aws", "azure", "microsoft", "llama", "meta", "grok", "xai", "mistral",
];

function tokenize(title: string): Set<string> {
  return new Set(
    normalizedTitleKey(title)
      .split(" ")
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );
}

function brandTokens(tokens: Set<string>): Set<string> {
  return new Set([...tokens].filter((token) => KNOWN_BRANDS.includes(token)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** True when two titles are about the same brand-disambiguated entity/event, not just similar prose. */
export function isSameEntity(titleA: string, titleB: string, threshold: number): boolean {
  const tokensA = tokenize(titleA);
  const tokensB = tokenize(titleB);
  const brandsA = brandTokens(tokensA);
  const brandsB = brandTokens(tokensB);
  if (brandsA.size > 0 && brandsB.size > 0) {
    const sharedBrand = [...brandsA].some((brand) => brandsB.has(brand));
    if (!sharedBrand) return false;
  }
  return jaccard(tokensA, tokensB) >= threshold;
}

function bestRepresentative(items: Item[]): Item {
  const sourceKindPriority: Record<Item["sourceKind"], number> = {
    rss: 0,
    githubReleases: 1,
    hn: 2,
    lobsters: 3,
    reddit: 4,
    bluesky: 5,
  };
  return [...items].sort((a, b) => sourceKindPriority[a.sourceKind] - sourceKindPriority[b.sourceKind])[0];
}

function mergeGroup(items: Item[]): Item {
  const representative = bestRepresentative(items);
  const corroboratingSourceIds = [...new Set(items.map((item) => item.sourceId).filter((id) => id !== representative.sourceId))];
  return { ...representative, corroboratingSourceIds };
}

/** Cascade: canonical URL -> normalized title -> content hash -> loose entity similarity (brand-disambiguated). */
export function canonicalizeAndDedupe(items: Item[]): DedupeOutput {
  const byCanonicalUrl = new Map<string, Item[]>();
  for (const item of items) {
    const key = canonicalizeUrl(item.url);
    const bucket = byCanonicalUrl.get(key);
    if (bucket) bucket.push(item);
    else byCanonicalUrl.set(key, [item]);
  }

  const byTitle = new Map<string, Item[]>();
  for (const bucket of byCanonicalUrl.values()) {
    const merged = mergeGroup(bucket);
    const key = normalizedTitleKey(merged.title);
    const titleBucket = byTitle.get(key);
    if (titleBucket) titleBucket.push(merged);
    else byTitle.set(key, [merged]);
  }

  const byContent = new Map<string, Item[]>();
  for (const bucket of byTitle.values()) {
    const merged = mergeGroup(bucket);
    const key = contentHashKey(merged.body || merged.title);
    const contentBucket = byContent.get(key);
    if (contentBucket) contentBucket.push(merged);
    else byContent.set(key, [merged]);
  }

  const representatives = [...byContent.values()].map(mergeGroup);

  const finalGroups: Item[][] = [];
  for (const item of representatives) {
    const matchIndex = finalGroups.findIndex((group) => isSameEntity(group[0].title, item.title, 0.6));
    if (matchIndex >= 0) finalGroups[matchIndex].push(item);
    else finalGroups.push([item]);
  }

  const deduped = finalGroups.map((group) => {
    const merged = mergeGroup(group);
    const corroboratingSourceIds = [
      ...new Set(group.flatMap((entry) => [entry.sourceId, ...entry.corroboratingSourceIds]).filter((id) => id !== merged.sourceId)),
    ];
    return { ...merged, corroboratingSourceIds };
  });

  return {
    uniqueCount: deduped.length,
    dupesRemoved: items.length - deduped.length,
    items: deduped,
    summary: `${deduped.length} unique stories after removing ${items.length - deduped.length} duplicates/republishes.`,
  };
}
