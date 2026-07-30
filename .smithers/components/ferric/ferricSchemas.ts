import { approvalDecisionSchema } from "smithers-orchestrator";
import { z } from "zod";

/**
 * Every persisted shape in the Operation Ferric campaign.
 *
 * Keys are `frc`-prefixed on purpose: output tables are shared BY NAME across
 * every workflow in a workspace DB, so a generic key like `review` would
 * ALTER-extend another workflow's table into a union of both column sets.
 *
 * Agent-written schemas carry required min-length / int fields so an empty
 * repaired `{}` fails validation and the engine's schema-retry loop re-extracts
 * the agent's real JSON instead of silently persisting an all-null row.
 */
export const ferricSchemas = {
  input: z.object({
    milestone: z.string().nullish(), // operator override; enum-validated in cfg()
    campaignRepoPath: z.string().nullish(), // MUST equal the launch root (foundation gate)
    reactRepoPath: z.string().nullish(), // pinned upstream checkout
    moduleQueuePath: z.string().nullish(),
    maxLanes: z.number().int().nullish(), // clamped 4–6
    modelSpentCents: z.number().int().nullish(), // operator-attested spend top-up
  }),

  frcFoundation: z.object({
    launchRootOk: z.boolean(),
    scriptsOk: z.boolean(),
    queueOk: z.boolean(),
    selfAuditOk: z.boolean(),
    detail: z.string().min(2),
  }),
  frcPlan: z.object({
    milestone: z.string().min(2),
    planMarkdown: z.string().min(400),
    workItems: z.string().min(2), // JSON [{id, kind, modules[], gate}]
  }),
  frcCanary: z.object({
    canary: z.string().min(3),
    ok: z.boolean(),
    evidence: z.string().min(5),
  }),
  frcDocReview: z.object({
    doc: z.string().min(2),
    reviewer: z.string().min(3),
    approved: z.boolean(),
    findings: z.string().min(10),
  }),
  frcOracle: z.object({
    passingCount: z.number().int(),
    totalCount: z.number().int(),
    manifestSha256: z.string().min(16),
    ok: z.boolean(),
  }),
  frcBenchContract: z.object({
    contractSha256: z.string().min(16),
    frozen: z.boolean(),
  }),
  frcPoc: z.object({
    ratioX1000: z.number().int(),
    protocolRevisions: z.number().int(),
    abiChoice: z.string().min(3),
    withinKillGate: z.boolean(),
  }),

  frcQueue: z.object({
    totalRows: z.number().int(),
    leafCount: z.number().int(),
    cohortCount: z.number().int(),
    sccModules: z.number().int(),
    slices: z.string().min(2), // JSON slice list (disk-backed data, not run input)
  }),
  frcSlice: z.object({
    sliceId: z.string().min(2),
    summary: z.string().min(20),
    cargoCheckOk: z.boolean(),
    testsOk: z.boolean(),
    round: z.number().int(),
  }),
  frcReview: z.object({
    sliceId: z.string().min(2),
    reviewer: z.string().min(3),
    approved: z.boolean(),
    findings: z.string().min(10),
  }),
  frcVerify: z.object({
    sliceId: z.string().min(2),
    ok: z.boolean(),
    testsPassed: z.number().int(),
    testsTotal: z.number().int(),
    reasons: z.string().min(2),
    // The lane patch, for the review UI's DiffHunks surface. Without this field
    // zod stripped it and the diff view could never render. Truncated at the
    // capture site so a huge slice cannot bloat the row.
    diffText: z.string().nullish(),
  }),
  frcLand: z.object({
    sliceId: z.string().min(2),
    landed: z.boolean(),
    regression: z.boolean(),
    ratchetBefore: z.number().int(),
    ratchetAfter: z.number().int(),
    haltEpoch: z.number().int(),
  }),
  frcSuite: z.object({
    leg: z.string().min(3),
    passingCount: z.number().int(),
    totalCount: z.number().int(),
    green: z.boolean(),
    xfailBucketC: z.number().int(),
  }),
  frcBench: z.object({
    bench: z.string().min(3),
    ratioX1000: z.number().int(),
    withinContract: z.boolean(),
  }),
  frcFuzz: z.object({
    mode: z.string().min(3),
    casesRun: z.number().int(),
    divergences: z.number().int(),
    clean: z.boolean(),
  }),
  frcSoak: z.object({
    app: z.string().min(3),
    green: z.boolean(),
    notes: z.string().min(5),
  }),
  frcDriftAlert: z.object({ recommendation: z.string().min(20) }),
  frcBudget: z.object({
    spentCents: z.number().int(),
    capCents: z.number().int(),
    levelPctX100: z.number().int(), // spend/cap ×10000, integer
    admitNewWork: z.boolean(),
    note: z.string().min(2),
  }),
  frcPublishDecision: z.object({
    artifact: z.string().min(3),
    shouldPublish: z.boolean(),
    reason: z.string().min(10),
    idempotencyKey: z.string().min(8).regex(/^[A-Za-z0-9._-]+$/),
  }),
  frcPublishAct: z.object({
    artifact: z.string().min(3),
    published: z.boolean(),
    receipt: z.string().min(2),
  }),
  frcCloseout: z.object({
    milestone: z.string().min(2),
    summaryMarkdown: z.string().min(100),
    killed: z.boolean(),
  }),
  frcSidecarShadow: z.object({
    sliceId: z.string().min(2),
    summary: z.string().min(20),
    cargoCheckOk: z.boolean(),
    testsOk: z.boolean(),
    round: z.number().int(),
  }),

  /** Per-account quota snapshot summary; the snapshot itself is on disk. */
  frcAccounts: z.object({
    snapshotPath: z.string().min(4),
    accountCount: z.number().int(),
    claudeCount: z.number().int(),
    codexCount: z.number().int(),
    summary: z.string().min(2),
  }),

  frcGate: approvalDecisionSchema, // ONE decision table; each gate is its own nodeId
};
