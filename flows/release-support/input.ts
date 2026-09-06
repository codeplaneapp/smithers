import { Schema } from "effect"
import { ContentInput, ReleaseInput } from "./schema.ts"

export const version = (value: unknown): string => {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(value)) throw new Error("version must be a semver without a v prefix or build metadata")
  for (const part of value.split("-").slice(1).join("-").split(".")) {
    if (/^0\d+$/.test(part)) throw new Error("Numeric prerelease identifiers cannot have leading zeros")
  }
  return value
}
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be a JSON object")
  return value as Record<string, unknown>
}
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown input field: ${key}`)
}

/** Normalize the old bump option into an explicit, persisted release version. */
const requestedVersion = (input: Record<string, unknown>, current: string): string => {
  if (input.bump === undefined) return version(input.version ?? current)
  if (input.version !== undefined) throw new Error("Choose version or bump, not both")
  if (!["major", "minor", "patch"].includes(String(input.bump))) throw new Error("bump must be major, minor, or patch")
  version(current)
  const [base, prerelease] = current.split("-", 2)
  let [major, minor, patch] = base!.split(".").map(BigInt) as [bigint, bigint, bigint]
  if (input.bump === "major") { if (minor !== 0n || patch !== 0n || !prerelease) major++; minor = 0n; patch = 0n }
  else if (input.bump === "minor") { if (patch !== 0n || !prerelease) minor++; patch = 0n }
  else if (!prerelease) patch++
  return `${major}.${minor}.${patch}`
}

export const contentInput = (value: unknown, currentVersion: string): ContentInput => {
  const input = record(value)
  keys(input, [...Object.keys(ContentInput.fields), "bump"])
  const resolvedVersion = requestedVersion(input, currentVersion)
  const { bump: _bump, ...fields } = input
  const channels = input.channels === undefined ? {} : record(input.channels)
  keys(channels, ["changelog", "blog", "thread", "media"])
  const decoded = Schema.decodeUnknownSync(ContentInput)({
    from: "auto", dryRun: true, publish: false, postX: false, autoCommit: false, recording: null,
    title: "", notes: "", minScore: 0.86, maxRevisions: 2, maxTweets: 8, maxTweetChars: 280,
    ...fields, version: resolvedVersion,
    channels: { changelog: true, blog: true, thread: true, media: true, ...channels }
  })
  version(decoded.version)
  if (!Number.isInteger(decoded.maxRevisions) || decoded.maxRevisions < 0 || decoded.maxRevisions > 3) throw new Error("maxRevisions must be an integer from 0 to 3")
  if (!Number.isFinite(decoded.minScore) || decoded.minScore < 0 || decoded.minScore > 1) throw new Error("minScore must be between 0 and 1")
  if (!Number.isInteger(decoded.maxTweets) || decoded.maxTweets < 1 || decoded.maxTweets > 12) throw new Error("maxTweets must be an integer from 1 to 12")
  if (!Number.isInteger(decoded.maxTweetChars) || decoded.maxTweetChars < 1 || decoded.maxTweetChars > 280) throw new Error("maxTweetChars must be an integer from 1 to 280")
  if (!decoded.channels.changelog && !decoded.channels.blog && !decoded.channels.thread) throw new Error("Enable at least one text channel")
  if (decoded.postX && (!decoded.publish || !decoded.channels.thread)) throw new Error("postX requires publish=true and channels.thread=true")
  if (decoded.autoCommit && !decoded.publish) throw new Error("autoCommit requires publish=true")
  if (decoded.recording) {
    const url = new URL(decoded.recording.url)
    if (!/^https?:$/.test(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("recording.url must be a local HTTP(S) origin without credentials")
  }
  return decoded
}

export const releaseInput = (value: unknown, currentVersion: string): ReleaseInput => {
  const input = record(value)
  keys(input, [...Object.keys(ReleaseInput.fields), "bump"])
  const resolvedVersion = requestedVersion(input, currentVersion)
  const { bump: _bump, ...fields } = input
  const decoded = Schema.decodeUnknownSync(ReleaseInput)({
    from: "auto", phase: "prepare", dryRun: true,
    contentArtifact: "", requireContentApproval: true, provenance: true, ...fields, version: resolvedVersion
  })
  version(decoded.version)
  return decoded
}
