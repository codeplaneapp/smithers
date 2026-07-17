import { existsSync, readFileSync } from "node:fs";
import { z } from "zod/v4";
import { agents } from "../../agents";
import { openDb } from "./db";

const weightsSchema = z.object({
  smithersImpact: z.number(),
  strategicRelevance: z.number(),
  actionability: z.number(),
  urgency: z.number(),
  novelty: z.number(),
  confidence: z.number(),
});

const cloudflareEnvSchema = z.object({
  accountIdEnv: z.string(),
  apiTokenEnv: z.string(),
  kvNamespaceIdEnv: z.string(),
  r2BucketEnv: z.string(),
});

export const runConfigSchema = z.object({
  sourcesPath: z.string(),
  dbPath: z.string(),
  reportsDir: z.string(),
  cheapPoolName: z.string(),
  strongPoolName: z.string(),
  criticalSourceIds: z.array(z.string()),
  assessBatchSize: z.number().int().min(1).max(50),
  maxTopStories: z.number().int().min(1),
  maxActions: z.number().int().min(1),
  lighterSideMin: z.number().int().min(0),
  lighterSideMax: z.number().int().min(1),
  composeWordMin: z.number().int(),
  composeWordMax: z.number().int(),
  fingerprintRetentionDays: z.number().int().min(1),
  weights: weightsSchema,
  cloudflare: cloudflareEnvSchema,
});
export type RunConfig = z.infer<typeof runConfigSchema>;

const rssSourceSchema = z.object({ id: z.string(), url: z.string(), critical: z.boolean().default(false) });
const githubReleasesSourceSchema = z.object({ id: z.string(), owner: z.string(), repo: z.string(), critical: z.boolean().default(false) });
const hnSourceSchema = z.object({ id: z.string(), query: z.string(), critical: z.boolean().default(false) });
const lobstersSourceSchema = z.object({ id: z.string(), tag: z.string(), critical: z.boolean().default(false) });
const redditSourceSchema = z.object({ id: z.string(), subreddit: z.string(), critical: z.boolean().default(false) });
const blueskySourceSchema = z.object({ id: z.string(), query: z.string(), critical: z.boolean().default(false) });

export const sourcesConfigSchema = z.object({
  rss: z.array(rssSourceSchema).default([]),
  githubReleases: z.array(githubReleasesSourceSchema).default([]),
  hn: z.array(hnSourceSchema).default([]),
  lobsters: z.array(lobstersSourceSchema).default([]),
  reddit: z.array(redditSourceSchema).default([]),
  bluesky: z.array(blueskySourceSchema).default([]),
});
export type SourcesConfig = z.infer<typeof sourcesConfigSchema>;

export type RssSource = z.infer<typeof rssSourceSchema>;
export type GithubReleasesSource = z.infer<typeof githubReleasesSourceSchema>;
export type HnSource = z.infer<typeof hnSourceSchema>;
export type LobstersSource = z.infer<typeof lobstersSourceSchema>;
export type RedditSource = z.infer<typeof redditSourceSchema>;
export type BlueskySource = z.infer<typeof blueskySourceSchema>;

export function readJson(path: string): unknown {
  if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadRunConfig(configPath: string): RunConfig {
  return runConfigSchema.parse(readJson(configPath));
}

export function loadSourcesConfig(sourcesPath: string): SourcesConfig {
  return sourcesConfigSchema.parse(readJson(sourcesPath));
}

export function countSources(sources: SourcesConfig): number {
  return (
    sources.rss.length +
    sources.githubReleases.length +
    sources.hn.length +
    sources.lobsters.length +
    sources.reddit.length +
    sources.bluesky.length
  );
}

export function allCriticalSourceIds(sources: SourcesConfig, configured: string[]): string[] {
  const fromKinds = [
    ...sources.rss.filter((s) => s.critical).map((s) => s.id),
    ...sources.githubReleases.filter((s) => s.critical).map((s) => s.id),
    ...sources.hn.filter((s) => s.critical).map((s) => s.id),
    ...sources.lobsters.filter((s) => s.critical).map((s) => s.id),
    ...sources.reddit.filter((s) => s.critical).map((s) => s.id),
    ...sources.bluesky.filter((s) => s.critical).map((s) => s.id),
  ];
  return [...new Set([...configured, ...fromKinds])];
}

export function resolvePoolName(name: string): boolean {
  return Array.isArray((agents as Record<string, unknown>)[name]) && ((agents as Record<string, unknown[]>)[name]?.length ?? 0) > 0;
}

export function detectCloudflareCreds(config: RunConfig): {
  present: boolean;
  accountId: string | null;
  apiToken: string | null;
  kvNamespaceId: string | null;
  r2Bucket: string | null;
} {
  const accountId = process.env[config.cloudflare.accountIdEnv]?.trim() || null;
  const apiToken = process.env[config.cloudflare.apiTokenEnv]?.trim() || null;
  const kvNamespaceId = process.env[config.cloudflare.kvNamespaceIdEnv]?.trim() || null;
  const r2Bucket = process.env[config.cloudflare.r2BucketEnv]?.trim() || null;
  return {
    present: Boolean(accountId && apiToken && kvNamespaceId && r2Bucket),
    accountId,
    apiToken,
    kvNamespaceId,
    r2Bucket,
  };
}

export function resolveCloudflareCreds(config: RunConfig): { accountId: string; apiToken: string; kvNamespaceId: string; r2Bucket: string } | null {
  const creds = detectCloudflareCreds(config);
  if (!creds.present || !creds.accountId || !creds.apiToken || !creds.kvNamespaceId || !creds.r2Bucket) return null;
  return { accountId: creds.accountId, apiToken: creds.apiToken, kvNamespaceId: creds.kvNamespaceId, r2Bucket: creds.r2Bucket };
}

export function loadSources(configPath: string): SourcesConfig {
  const config = loadRunConfig(configPath);
  return loadSourcesConfig(config.sourcesPath);
}

export function resolveEffectiveMode(
  publishMode: "auto" | "archive-only" | "publish" | null,
  cfCredsPresent: boolean,
): "archive-only" | "publish" {
  if (publishMode === "archive-only") return "archive-only";
  if (publishMode === "publish") return "publish";
  return cfCredsPresent ? "publish" : "archive-only";
}

export type LoadedConfigState = {
  config: RunConfig;
  sources: SourcesConfig;
  sourceCount: number;
  criticalSourceIds: string[];
  cheapPoolOk: boolean;
  strongPoolOk: boolean;
  dbPath: string;
  schemaCreated: boolean;
  cfCredsPresent: boolean;
  effectiveMode: "archive-only" | "publish";
};

export function loadConfigAndState(configPath: string, publishModeInput: "auto" | "archive-only" | "publish" | null): LoadedConfigState {
  const config = loadRunConfig(configPath);
  const sources = loadSourcesConfig(config.sourcesPath);
  const sourceCount = countSources(sources);
  if (sourceCount === 0) throw new Error(`${config.sourcesPath} configures zero sources.`);
  const criticalSourceIds = allCriticalSourceIds(sources, config.criticalSourceIds);
  const cheapPoolOk = resolvePoolName(config.cheapPoolName);
  const strongPoolOk = resolvePoolName(config.strongPoolName);
  if (!cheapPoolOk) throw new Error(`cheapPoolName "${config.cheapPoolName}" does not resolve to a non-empty pool in .smithers/agents.ts`);
  if (!strongPoolOk) throw new Error(`strongPoolName "${config.strongPoolName}" does not resolve to a non-empty pool in .smithers/agents.ts`);
  const { schemaCreated } = openDb(config.dbPath);
  const creds = detectCloudflareCreds(config);
  const effectiveMode = resolveEffectiveMode(publishModeInput, creds.present);
  return {
    config,
    sources,
    sourceCount,
    criticalSourceIds,
    cheapPoolOk,
    strongPoolOk,
    dbPath: config.dbPath,
    schemaCreated,
    cfCredsPresent: creds.present,
    effectiveMode,
  };
}
