import { z } from "zod/v4";

export const SOURCE_KINDS = ["rss", "githubReleases", "hn", "lobsters", "reddit", "bluesky"] as const;
export const sourceKindSchema = z.enum(SOURCE_KINDS);

export const itemSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceKind: sourceKindSchema,
  url: z.string(),
  title: z.string(),
  body: z.string().default(""),
  author: z.string().nullable().default(null),
  publishedAt: z.string().nullable().default(null),
  retrievedAt: z.string(),
  dateUncertain: z.boolean().default(false),
  corroboratingSourceIds: z.array(z.string()).default([]),
  isUpdate: z.boolean().default(false),
});

export const coverageRowSchema = z.object({
  sourceId: z.string(),
  kind: sourceKindSchema,
  ok: z.boolean(),
  error: z.string().nullable().default(null),
  itemCount: z.number().int().default(0),
  retried: z.boolean().default(false),
});

export const fetchSourceRowSchema = coverageRowSchema.extend({
  items: z.array(itemSchema).default([]),
});

export function makeFetchResultSchema(kind: (typeof SOURCE_KINDS)[number]) {
  return z.object({
    kind: z.literal(kind),
    sources: z.array(fetchSourceRowSchema),
    itemCount: z.number().int(),
    summary: z.string(),
  });
}

export const windowSchema = z.object({
  windowStart: z.string(),
  windowEnd: z.string(),
  issueDateEt: z.string(),
  overridden: z.boolean(),
  summary: z.string(),
});

export const configOutputSchema = z.object({
  configPath: z.string(),
  sourceCount: z.number().int(),
  criticalSourceIds: z.array(z.string()),
  cheapPoolName: z.string(),
  strongPoolName: z.string(),
  dbPath: z.string(),
  schemaCreated: z.boolean(),
  cfCredsPresent: z.boolean(),
  effectiveMode: z.enum(["archive-only", "publish"]),
  summary: z.string(),
});

export const dateUncertainSampleSchema = z.object({
  sourceId: z.string(),
  title: z.string(),
  url: z.string(),
});

export const normalizeSchema = z.object({
  itemCount: z.number().int(),
  dateUncertainCount: z.number().int(),
  coverage: z.array(coverageRowSchema),
  degraded: z.boolean(),
  criticalFailed: z.boolean(),
  items: z.array(itemSchema),
  dateUncertainSample: z.array(dateUncertainSampleSchema).default([]),
  summary: z.string(),
});

export const windowFilterSchema = z.object({
  inWindowCount: z.number().int(),
  droppedCount: z.number().int(),
  items: z.array(itemSchema),
  summary: z.string(),
});

export const dedupeSchema = z.object({
  uniqueCount: z.number().int(),
  dupesRemoved: z.number().int(),
  items: z.array(itemSchema),
  summary: z.string(),
});

export const seenSchema = z.object({
  freshCount: z.number().int(),
  seenDropped: z.number().int(),
  updatesFlagged: z.number().int(),
  items: z.array(itemSchema),
  summary: z.string(),
});

export const clusterSchema = z.object({
  srcId: z.string(),
  title: z.string(),
  excerpt: z.string(),
  canonicalUrl: z.string(),
  publishedAt: z.string().nullable(),
  sourceIds: z.array(z.string()),
  sourceKinds: z.array(sourceKindSchema).default([]),
  itemIds: z.array(z.string()),
  isUpdate: z.boolean().default(false),
  categoryHints: z.array(z.string()).default([]),
});

export const clusterEventsSchema = z.object({
  clusterCount: z.number().int(),
  clusters: z.array(clusterSchema),
  srcIdMap: z.record(z.string(), z.string()),
  summary: z.string(),
});

export const editorialAssessmentSchema = z.object({
  srcId: z.string(),
  smithersImpact: z.number().min(0).max(5),
  strategicRelevance: z.number().min(0).max(5),
  actionability: z.number().min(0).max(5),
  urgency: z.number().min(0).max(5),
  novelty: z.number().min(0).max(5),
  confidence: z.number().min(0).max(5),
  categories: z.array(z.string()).default([]),
  whyItMatters: z.string(),
  recommendedAction: z.string().default(""),
  citedSourceIds: z.array(z.string()).default([]),
});

export function makeAssessBatchSchema() {
  return z.object({
    batchIndex: z.number().int(),
    assessments: z.array(editorialAssessmentSchema),
    summary: z.string(),
  });
}

export const mergeAssessmentsSchema = z.object({
  assessedCount: z.number().int(),
  invalidCount: z.number().int(),
  assessments: z.array(editorialAssessmentSchema),
  summary: z.string(),
});

export const rankedStorySchema = editorialAssessmentSchema.extend({
  title: z.string(),
  excerpt: z.string(),
  score: z.number(),
});

export const rankedActionSchema = z.object({
  srcId: z.string(),
  action: z.string(),
});

export const lighterSideCandidateSchema = z.object({
  srcId: z.string(),
  title: z.string(),
  excerpt: z.string(),
});

export const rankAndSelectSchema = z.object({
  topStories: z.array(rankedStorySchema),
  actions: z.array(rankedActionSchema),
  briefCandidates: z.array(rankedStorySchema),
  lighterSideCandidates: z.array(lighterSideCandidateSchema),
  selectedCount: z.number().int(),
  summary: z.string(),
});

export const lighterSidePickSchema = z.object({
  srcId: z.string(),
  whyFunny: z.string(),
});

export const curateLighterSideSchema = z.object({
  picks: z.array(lighterSidePickSchema),
  summary: z.string(),
});

export const issueStorySchema = z.object({
  srcId: z.string(),
  headline: z.string(),
  body: z.string(),
  whyItMatters: z.string(),
  categories: z.array(z.string()).default([]),
});

export const issueActionSchema = z.object({ srcId: z.string(), action: z.string() });
export const issueBriefSchema = z.object({ srcId: z.string(), text: z.string() });
export const issueLighterItemSchema = z.object({ srcId: z.string(), text: z.string() });

export const issueSectionKindSchema = z.enum(["topStories", "recommendedActions", "briefs", "lighterSide"]);

export const issueSchema = z.object({
  issueDateEt: z.string(),
  headline: z.string(),
  intro: z.string(),
  topStories: z.array(issueStorySchema),
  recommendedActions: z.array(issueActionSchema),
  briefs: z.array(issueBriefSchema),
  lighterSide: z.array(issueLighterItemSchema),
  sectionOrder: z.array(issueSectionKindSchema),
  coverageStatement: z.string(),
  quietDay: z.boolean().default(false),
});

export const composeEditorialSchema = z.object({
  issue: issueSchema,
  wordCount: z.number().int(),
  attempt: z.number().int(),
  summary: z.string(),
});

export const verifySchema = z.object({
  passed: z.boolean(),
  errors: z.array(z.string()),
  attempt: z.number().int(),
  summary: z.string(),
});

export const renderSchema = z.object({
  issueJson: z.string(),
  markdown: z.string(),
  html: z.string(),
  storyCount: z.number().int(),
  coverageAppendixPresent: z.boolean(),
  summary: z.string(),
});

export const artifactPathsSchema = z.object({
  md: z.string(),
  html: z.string(),
  json: z.string(),
});

export const archiveSchema = z.object({
  mode: z.enum(["r2", "local"]),
  paths: artifactPathsSchema,
  bytesWritten: z.number().int(),
  summary: z.string(),
});

export const publishSchema = z.object({
  attempted: z.boolean(),
  published: z.boolean(),
  idempotentSkip: z.boolean(),
  skippedReason: z.string().nullable().default(null),
  kvKeys: z.array(z.string()).default([]),
  deliveryId: z.string().nullable().default(null),
  summary: z.string(),
});

export const commitSchema = z.object({
  committed: z.boolean(),
  fingerprintsAdded: z.number().int(),
  pruned: z.number().int(),
  skippedReason: z.string().nullable().default(null),
  summary: z.string(),
});

export const finalizeSchema = z.object({
  status: z.enum(["published", "archived", "archived-unverified", "empty-day", "degraded"]),
  issueDateEt: z.string(),
  storyCount: z.number().int(),
  actionCount: z.number().int(),
  artifactPaths: artifactPathsSchema,
  published: z.boolean(),
  degraded: z.boolean(),
  warnings: z.array(z.string()).default([]),
  summary: z.string(),
});

export const modelProviderNameSchema = z.enum(["anthropic", "openai", "gemini"]);
export const modelProviderModeSchema = z.enum(["auto", "anthropic", "openai", "gemini"]);
export const providerProbeSchema = z.object({
  provider: modelProviderNameSchema,
  attempted: z.boolean(),
  ok: z.boolean(),
  classification: z.enum(["ok", "missing-key", "auth", "billing", "network", "other"]),
  detail: z.string(),
});

export const providerSelectionSchema = z.object({
  mode: modelProviderModeSchema,
  provider: modelProviderNameSchema,
  cheapModel: z.string(),
  strongModel: z.string(),
  reason: z.string(),
  probes: z.array(providerProbeSchema),
  selectedAt: z.string(),
  summary: z.string(),
});

export const assertVerifiedSchema = z.object({ ok: z.boolean() });

export type Item = z.infer<typeof itemSchema>;
export type CoverageRow = z.infer<typeof coverageRowSchema>;
export type DateUncertainSample = z.infer<typeof dateUncertainSampleSchema>;
export type FetchSourceRow = z.infer<typeof fetchSourceRowSchema>;
export type WindowOutput = z.infer<typeof windowSchema>;
export type ConfigOutput = z.infer<typeof configOutputSchema>;
export type NormalizeOutput = z.infer<typeof normalizeSchema>;
export type WindowFilterOutput = z.infer<typeof windowFilterSchema>;
export type DedupeOutput = z.infer<typeof dedupeSchema>;
export type SeenOutput = z.infer<typeof seenSchema>;
export type Cluster = z.infer<typeof clusterSchema>;
export type ClusterEventsOutput = z.infer<typeof clusterEventsSchema>;
export type EditorialAssessment = z.infer<typeof editorialAssessmentSchema>;
export type MergeAssessmentsOutput = z.infer<typeof mergeAssessmentsSchema>;
export type RankedStory = z.infer<typeof rankedStorySchema>;
export type LighterSideCandidate = z.infer<typeof lighterSideCandidateSchema>;
export type RankAndSelectOutput = z.infer<typeof rankAndSelectSchema>;
export type CurateLighterSideOutput = z.infer<typeof curateLighterSideSchema>;
export type Issue = z.infer<typeof issueSchema>;
export type ComposeEditorialOutput = z.infer<typeof composeEditorialSchema>;
export type VerifyOutput = z.infer<typeof verifySchema>;
export type RenderOutput = z.infer<typeof renderSchema>;
export type ArtifactPaths = z.infer<typeof artifactPathsSchema>;
export type ArchiveOutput = z.infer<typeof archiveSchema>;
export type PublishOutput = z.infer<typeof publishSchema>;
export type CommitOutput = z.infer<typeof commitSchema>;
export type FinalizeOutput = z.infer<typeof finalizeSchema>;
export type ModelProviderNameOutput = z.infer<typeof modelProviderNameSchema>;
export type ProviderProbeOutput = z.infer<typeof providerProbeSchema>;
export type ProviderSelectionOutput = z.infer<typeof providerSelectionSchema>;
