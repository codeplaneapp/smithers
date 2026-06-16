import { z } from "zod/v4";

export const templateIdSchema = z.enum([
  "capability-reveal",
  "developer-api-contract",
  "agent-workflow-primitive",
  "production-hardening",
  "infra-performance",
  "major-version-migration",
  "launch-roundup",
  "engineering-deep-dive",
  "ecosystem-bridge",
  "category-thesis",
  "small-maintenance",
]);

export const releaseTypeSchema = z.enum([
  "developer-api-contract",
  "agent-workflow-primitive",
  "production-hardening",
  "infra-performance",
  "major-version-migration",
  "launch-roundup",
  "engineering-deep-dive",
  "ecosystem-bridge",
  "small-maintenance",
]);

export const releaseContentInputSchema = z.object({
  version: z.string().optional(),
  bump: z.enum(["patch", "minor", "major"]).optional(),
  range: z.string().optional().describe("Git revision range. Default: last tag..HEAD."),
  releaseDate: z.string().optional(),
  dryRun: z.boolean().default(true),
  publish: z.boolean().default(false),
  allowUnreviewedPublish: z.boolean().default(false),
  channels: z
    .object({
      changelog: z.boolean().default(true),
      tweetThread: z.boolean().default(true),
      blogPost: z.boolean().default(true),
    })
    .default({ changelog: true, tweetThread: true, blogPost: true }),
  skip: z
    .object({
      probe: z.boolean().default(false),
      collectGit: z.boolean().default(false),
      collectDocs: z.boolean().default(false),
      analyze: z.boolean().default(false),
      templateSelection: z.boolean().default(false),
      changelog: z.boolean().default(false),
      tweetThread: z.boolean().default(false),
      blogPost: z.boolean().default(false),
      scoring: z.boolean().default(false),
      approval: z.boolean().default(false),
      writePreviewArtifacts: z.boolean().default(false),
      renderMedia: z.boolean().default(false),
      publishX: z.boolean().default(false),
      publishBlog: z.boolean().default(false),
      publishChangelog: z.boolean().default(false),
      publishThreadFile: z.boolean().default(false),
    })
    .default({
      probe: false,
      collectGit: false,
      collectDocs: false,
      analyze: false,
      templateSelection: false,
      changelog: false,
      tweetThread: false,
      blogPost: false,
      scoring: false,
      approval: false,
      writePreviewArtifacts: false,
      renderMedia: false,
      publishX: false,
      publishBlog: false,
      publishChangelog: false,
      publishThreadFile: false,
    }),
  output: z
    .object({
      artifactDir: z.string().default(".smithers/executions/release-content"),
      changelogPath: z.string().optional(),
      blogPath: z.string().optional(),
      threadPath: z.string().optional(),
      writePreviewFiles: z.boolean().default(true),
      overwrite: z.boolean().default(false),
    })
    .default({
      artifactDir: ".smithers/executions/release-content",
      writePreviewFiles: true,
      overwrite: false,
    }),
  releaseContext: z
    .object({
      title: z.string().optional(),
      summary: z.string().optional(),
      manualHighlights: z.array(z.string()).default([]),
      manualRisks: z.array(z.string()).default([]),
      manualProof: z.array(z.string()).default([]),
      links: z
        .array(
          z.object({
            label: z.string(),
            url: z.string(),
          }),
        )
        .default([]),
    })
    .default({ manualHighlights: [], manualRisks: [], manualProof: [], links: [] }),
  template: z
    .object({
      forceTemplateId: templateIdSchema.optional(),
      allowedTemplateIds: z.array(templateIdSchema).default([]),
      blockedTemplateIds: z.array(templateIdSchema).default([]),
      audience: z
        .enum([
          "agent-builders",
          "platform-engineers",
          "maintainers",
          "founders",
          "general-developers",
        ])
        .default("agent-builders"),
      tone: z
        .enum(["systems", "founder-led", "launch-week", "technical-deep-dive", "minimal"])
        .default("systems"),
    })
    .default({
      allowedTemplateIds: [],
      blockedTemplateIds: [],
      audience: "agent-builders",
      tone: "systems",
    }),
  tweetThread: z
    .object({
      maxTweets: z.number().int().min(1).max(20).default(8),
      maxChars: z.number().int().min(100).max(280).default(280),
      delaySeconds: z.number().int().min(0).max(60).default(3),
      includeEmojis: z.boolean().default(false),
      includeThreadNumbering: z.boolean().default(true),
      ctaUrl: z.string().default("https://smithers.sh"),
      generateMedia: z.boolean().default(true),
    })
    .default({
      maxTweets: 8,
      maxChars: 280,
      delaySeconds: 3,
      includeEmojis: false,
      includeThreadNumbering: true,
      ctaUrl: "https://smithers.sh",
      generateMedia: true,
    }),
  blogPost: z
    .object({
      targetWords: z.number().int().min(500).max(5000).default(1600),
      includeCodeExample: z.boolean().default(true),
      includeMigrationNotes: z.boolean().default(true),
      frontmatter: z.record(z.string(), z.unknown()).default({}),
    })
    .default({
      targetWords: 1600,
      includeCodeExample: true,
      includeMigrationNotes: true,
      frontmatter: {},
    }),
  quality: z
    .object({
      minScore: z.number().min(0).max(1).default(0.86),
      maxRevisionLoops: z.number().int().min(0).max(5).default(2),
      requireClaimLedger: z.boolean().default(true),
      requireApprovalBeforePublish: z.boolean().default(true),
      bannedPhrases: z
        .array(z.string())
        .default(["game-changing", "revolutionary", "seamless", "unlock the future", "10x"]),
    })
    .default({
      minScore: 0.86,
      maxRevisionLoops: 2,
      requireClaimLedger: true,
      requireApprovalBeforePublish: true,
      bannedPhrases: ["game-changing", "revolutionary", "seamless", "unlock the future", "10x"],
    }),
  additionalPrompts: z
    .object({
      global: z.string().default(""),
      collectContext: z.string().default(""),
      analyzeRelease: z.string().default(""),
      selectTemplate: z.string().default(""),
      changelog: z.string().default(""),
      tweetThread: z.string().default(""),
      blogPost: z.string().default(""),
      editor: z.string().default(""),
      scorer: z.string().default(""),
    })
    .default({
      global: "",
      collectContext: "",
      analyzeRelease: "",
      selectTemplate: "",
      changelog: "",
      tweetThread: "",
      blogPost: "",
      editor: "",
      scorer: "",
    }),
});

export const probeSchema = z.object({
  currentVersion: z.string(),
  nextVersion: z.string(),
  version: z.string(),
  bump: z.enum(["patch", "minor", "major"]).nullable(),
  range: z.string(),
  previousTag: z.string().nullable(),
  currentSha: z.string(),
  releaseDate: z.string(),
  changelogPath: z.string(),
  blogPath: z.string(),
  threadPath: z.string(),
  artifactRoot: z.string(),
});

export const sourceRefSchema = z.object({
  kind: z.enum(["commit", "diff", "file", "changelog", "manual", "package", "github"]),
  ref: z.string(),
  quoteOrSummary: z.string(),
  confidence: z.number().min(0).max(1),
});

export const collectedContextSchema = z.looseObject({
  version: z.string(),
  range: z.string(),
  commits: z
    .array(
      z.object({
        sha: z.string(),
        subject: z.string(),
        body: z.string().default(""),
      }),
    )
    .default([]),
  changedFiles: z.array(z.string()).default([]),
  diffStats: z.string().default(""),
  fileExcerpts: z
    .array(
      z.object({
        path: z.string(),
        excerpt: z.string(),
      }),
    )
    .default([]),
  priorChangelogs: z
    .array(
      z.object({
        version: z.string(),
        excerpt: z.string(),
      }),
    )
    .default([]),
  priorThreads: z
    .array(
      z.object({
        version: z.string(),
        excerpt: z.string(),
      }),
    )
    .default([]),
  manualContext: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().default(""),
});

export const claimLedgerItemSchema = z.object({
  id: z.string(),
  claim: z.string(),
  sources: z.array(sourceRefSchema).default([]),
  allowedInMarketing: z.boolean(),
  risk: z.enum(["low", "medium", "high"]),
});

export const releaseAnalysisSchema = z.looseObject({
  version: z.string(),
  title: z.string(),
  oneSentenceSummary: z.string(),
  primaryAudience: z.string(),
  releaseType: releaseTypeSchema,
  userVisibleChanges: z.array(z.string()).default([]),
  internalChanges: z.array(z.string()).default([]),
  breakingChanges: z.array(z.string()).default([]),
  migrationNotes: z.array(z.string()).default([]),
  proofAssets: z.array(sourceRefSchema).default([]),
  claimLedger: z.array(claimLedgerItemSchema).default([]),
});

export const templateSelectionSchema = z.object({
  templateId: templateIdSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  channelPlan: z.object({
    changelog: z.string(),
    tweetThread: z.string(),
    blogPost: z.string(),
  }),
  requiredClaims: z.array(z.string()).default([]),
  forbiddenClaims: z.array(z.string()).default([]),
  candidateScores: z.record(z.string(), z.number()).default({}),
});

export const contentBriefSchema = z.looseObject({
  headline: z.string(),
  subheadline: z.string(),
  oneSentencePositioning: z.string(),
  primaryAudience: z.string(),
  oldWay: z.string(),
  newWay: z.string(),
  topClaims: z.array(z.string()).default([]),
  proof: z.array(z.string()).default([]),
  forbiddenClaims: z.array(z.string()).default([]),
  cta: z.string(),
  templateId: templateIdSchema,
  channelAngles: z.record(z.string(), z.string()).default({}),
});

export const changelogDraftSchema = z.object({
  title: z.string(),
  markdown: z.string(),
  highlights: z.array(z.string()).default([]),
  breakingChanges: z.array(z.string()).default([]),
  migrationNotes: z.array(z.string()).default([]),
  claimIds: z.array(z.string()).default([]),
});

export const threadDraftSchema = z.object({
  tweets: z
    .array(
      z.object({
        index: z.number(),
        text: z.string(),
        charCount: z.number(),
        claimIds: z.array(z.string()).default([]),
        mediaSuggestion: z.string().default(""),
      }),
    )
    .default([]),
  hook: z.string(),
  cta: z.string(),
  notes: z.string().default(""),
});

export const mediaAssetKindSchema = z.enum([
  "hero",
  "capability",
  "diagram",
  "changelog",
  "terminal",
]);

export const mediaAssetSchema = z.object({
  tweetIndex: z.number(),
  kind: mediaAssetKindSchema,
  suggestion: z.string().default(""),
  file: z.string(),
  sibling: z.string(),
  captureRecommended: z.boolean().default(false),
  command: z.string().nullable().default(null),
});

export const mediaAssetsSchema = z.object({
  generated: z.boolean(),
  assetDir: z.string(),
  files: z.array(z.string()).default([]),
  assets: z.array(mediaAssetSchema).default([]),
  captures: z
    .array(
      z.object({
        tweetIndex: z.number(),
        command: z.string(),
        suggestion: z.string().default(""),
      }),
    )
    .default([]),
  manifestPath: z.string().nullable().default(null),
  rasterizerPath: z.string().nullable().default(null),
  message: z.string().default(""),
});

export const blogOutlineSchema = z.object({
  title: z.string(),
  slug: z.string(),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        purpose: z.string(),
        claimIds: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  notes: z.string().default(""),
});

export const blogDraftSchema = z.object({
  title: z.string(),
  slug: z.string(),
  excerpt: z.string(),
  frontmatter: z.record(z.string(), z.unknown()).default({}),
  markdown: z.string(),
  wordCount: z.number(),
  claimIds: z.array(z.string()).default([]),
});

export const editedContentSchema = z.object({
  summary: z.string(),
  changelog: changelogDraftSchema.nullable().default(null),
  tweetThread: threadDraftSchema.nullable().default(null),
  blogPost: blogDraftSchema.nullable().default(null),
  notes: z.string().default(""),
});

export const deterministicCheckSchema = z.object({
  passed: z.boolean(),
  issues: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor"]),
        channel: z.enum(["changelog", "tweetThread", "blogPost", "all"]),
        issue: z.string(),
        fix: z.string(),
      }),
    )
    .default([]),
});

export const scoreReportSchema = z.object({
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  issues: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor"]),
        channel: z.enum(["changelog", "tweetThread", "blogPost", "all"]),
        issue: z.string(),
        fix: z.string(),
      }),
    )
    .default([]),
  checks: z.object({
    factuality: z.number().min(0).max(1),
    templateFit: z.number().min(0).max(1),
    specificity: z.number().min(0).max(1),
    smithersPositioning: z.number().min(0).max(1),
    channelFit: z.number().min(0).max(1),
    publishReadiness: z.number().min(0).max(1),
  }),
});

export const artifactWriteSchema = z.object({
  artifactDir: z.string(),
  files: z.array(z.string()).default([]),
  previewUrl: z.string().nullable().default(null),
  publishPlanPath: z.string(),
  latestPointerPath: z.string(),
});

export const approvalRecordSchema = z.object({
  approved: z.boolean(),
  markerPath: z.string().nullable().default(null),
  reviewedPath: z.string(),
  message: z.string(),
});

export const publishResultSchema = z.object({
  published: z.boolean(),
  dryRun: z.boolean().default(false),
  files: z.array(z.string()).default([]),
  tweetIds: z.array(z.string()).default([]),
  message: z.string(),
});

export type ReleaseContentInput = z.infer<typeof releaseContentInputSchema>;
export type Probe = z.infer<typeof probeSchema>;
export type CollectedContext = z.infer<typeof collectedContextSchema>;
export type ReleaseAnalysis = z.infer<typeof releaseAnalysisSchema>;
export type TemplateSelection = z.infer<typeof templateSelectionSchema>;
export type ContentBrief = z.infer<typeof contentBriefSchema>;
export type ThreadDraft = z.infer<typeof threadDraftSchema>;
export type EditedContent = z.infer<typeof editedContentSchema>;
export type DeterministicCheck = z.infer<typeof deterministicCheckSchema>;
export type ScoreReport = z.infer<typeof scoreReportSchema>;
export type MediaAssetKind = z.infer<typeof mediaAssetKindSchema>;
export type MediaAssets = z.infer<typeof mediaAssetsSchema>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeReleaseContentInput(input: unknown): ReleaseContentInput {
  // The engine fills unsupplied top-level input keys with null rather than
  // leaving them undefined, so zod's optional()/default() never apply. Strip
  // the nulls before parsing so a partial `smithers up --input '{...}'` works.
  const record = isPlainRecord(input) ? { ...input } : {};
  for (const key of Object.keys(record)) {
    if (record[key] === null) delete record[key];
  }
  return releaseContentInputSchema.parse(record);
}
