import { Schema } from "effect"

export class ReleaseError extends Schema.TaggedError<ReleaseError>()("ReleaseError", {
  step: Schema.String,
  message: Schema.String
}) {}

export const Version = Schema.NonEmptyString.check(Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/))

export const Channels = Schema.Struct({
  changelog: Schema.Boolean,
  blog: Schema.Boolean,
  thread: Schema.Boolean,
  media: Schema.Boolean
})

export const Recording = Schema.Struct({
  url: Schema.NonEmptyString,
  readySelector: Schema.NonEmptyString,
  steps: Schema.Array(Schema.Struct({
    kind: Schema.Literals(["click", "fill", "wait-text"]),
    selector: Schema.NonEmptyString,
    value: Schema.String
  })).check(Schema.isMaxLength(24))
})
export const RecordingAsset = Schema.Struct({ path: Schema.String, digest: Schema.String })

/** Normalized at the entry point; the persisted payload contains every default. */
export const ContentInput = Schema.Struct({
  version: Version,
  from: Schema.NonEmptyString,
  dryRun: Schema.Boolean,
  publish: Schema.Boolean,
  postX: Schema.Boolean,
  autoCommit: Schema.Boolean,
  recording: Schema.NullOr(Recording),
  channels: Channels,
  title: Schema.String,
  notes: Schema.String,
  minScore: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  maxRevisions: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  maxTweets: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
  maxTweetChars: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 280 }))
})
export type ContentInput = typeof ContentInput.Type

export const ReleaseInput = Schema.Struct({
  version: Version,
  from: Schema.NonEmptyString,
  phase: Schema.Literals(["prepare", "publish"]),
  dryRun: Schema.Boolean,
  contentArtifact: Schema.String,
  requireContentApproval: Schema.Boolean,
  provenance: Schema.Boolean
})
export type ReleaseInput = typeof ReleaseInput.Type

export const Evidence = Schema.Struct({
  version: Schema.String,
  currentVersion: Schema.String,
  sourceSha: Schema.String,
  from: Schema.String,
  date: Schema.String,
  commits: Schema.String,
  changes: Schema.String,
  documents: Schema.String,
  recordings: Schema.Array(RecordingAsset),
  sources: Schema.Array(Schema.String)
})
export type Evidence = typeof Evidence.Type

export const Analysis = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  highlights: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  migration: Schema.Array(Schema.String),
  claims: Schema.Array(Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    sources: Schema.Array(Schema.String)
  }))
})
export type Analysis = typeof Analysis.Type

export const Brief = Schema.Struct({
  template: Schema.String,
  angle: Schema.String,
  outline: Schema.Array(Schema.String)
})
export const Copy = Schema.Struct({ text: Schema.String, claimIds: Schema.Array(Schema.String) })
export const Thread = Schema.Struct({ tweets: Schema.Array(Copy) })
export const Draft = Schema.Struct({ changelog: Copy, blog: Copy, thread: Thread })
export type Draft = typeof Draft.Type

export const Review = Schema.Struct({
  passed: Schema.Boolean,
  score: Schema.Number,
  feedback: Schema.Array(Schema.String)
})
export type Review = typeof Review.Type

export const Artifact = Schema.Struct({
  directory: Schema.String,
  digest: Schema.String,
  version: Schema.String,
  sourceSha: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, digest: Schema.String })),
  approvalPrompt: Schema.String
})
export type Artifact = typeof Artifact.Type

export const ContentResult = Schema.Struct({
  status: Schema.Literals(["preview", "approved", "declined", "published"]),
  artifact: Artifact,
  files: Schema.Array(Schema.String),
  tweetIds: Schema.Array(Schema.String)
})
export type ContentResult = typeof ContentResult.Type

export const DocumentationAudit = Schema.Struct({
  passed: Schema.Boolean,
  missing: Schema.Array(Schema.String),
  explanation: Schema.String
})

export const Candidate = Schema.Struct({
  directory: Schema.String,
  digest: Schema.String,
  sourceSha: Schema.String,
  version: Schema.String,
  packageCount: Schema.Number,
  approvalPrompt: Schema.String
})
export type Candidate = typeof Candidate.Type

export const ReleaseResult = Schema.Struct({
  status: Schema.Literals(["preview", "prepared", "declined", "published"]),
  version: Schema.String,
  artifact: Schema.String,
  published: Schema.Array(Schema.String)
})
export type ReleaseResult = typeof ReleaseResult.Type
