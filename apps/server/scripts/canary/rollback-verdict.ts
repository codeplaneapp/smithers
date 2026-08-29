/*
 * CN-24 — "the previous Worker version is reachable and the receipt names it"
 * — as pure verdicts over already-fetched values. rollback-probe.ts is the
 * process shell around this file.
 *
 * What "reachable" can honestly mean: a prior Worker version has no public
 * URL, so nothing can fetch it. The assertable property is that it is
 * ROLLBACK-ELIGIBLE — still in Cloudflare's version list for the Worker, with
 * an id `wrangler rollback <id>` can target — and that the receipt names the
 * version actually serving traffic. The verdicts below never claim more.
 *
 * Response shapes are read off wrangler 4.123.0's own client rather than
 * guessed: `fetchDeployableVersions` destructures `{ items }` out of
 * `GET /accounts/{account}/workers/scripts/{name}/versions`, and
 * `fetchLatestDeployments` destructures `{ deployments }` out of
 * `GET .../deployments`, both through `fetchResult`, which returns the
 * envelope's `result`. Every parser here still returns a failure detail
 * instead of throwing, so a shape change reads as one legible FAIL line.
 */

export interface Verdict {
  readonly ok: boolean
  readonly detail: string
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string }

export interface WorkerVersion {
  readonly id: string
  readonly createdOn: string | undefined
  readonly message: string | undefined
}

export interface DeployedVersion {
  readonly id: string
  readonly percentage: number
}

export interface Receipt {
  readonly worker: string
  readonly dryRun: boolean
  readonly gitSha: string
  readonly timestamp: string
  readonly wranglerVersionId: string | null
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const preview = (body: string): string => body.trim().replace(/\s+/g, " ").slice(0, 200)

/** Read a deploy receipt written by scripts/deploy.ts. */
export const parseReceipt = (text: string): Parsed<Receipt> => {
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    return { ok: false, detail: `the receipt is not JSON: ${preview(text)}` }
  }
  const record = asRecord(raw)
  if (record === undefined) return { ok: false, detail: `the receipt is not an object: ${preview(text)}` }
  const worker = optionalString(record.worker)
  const gitSha = optionalString(record.gitSha)
  const timestamp = optionalString(record.timestamp)
  if (worker === undefined || gitSha === undefined || timestamp === undefined) {
    return { ok: false, detail: `the receipt is missing worker, gitSha, or timestamp: ${preview(text)}` }
  }
  const versionId = record.wranglerVersionId
  if (versionId !== null && typeof versionId !== "string") {
    return { ok: false, detail: `the receipt's wranglerVersionId is neither a string nor null: ${preview(text)}` }
  }
  return {
    ok: true,
    value: { worker, dryRun: record.dryRun === true, gitSha, timestamp, wranglerVersionId: versionId }
  }
}

/** Cloudflare's version list, newest first. */
export const parseVersionList = (body: unknown): Parsed<ReadonlyArray<WorkerVersion>> => {
  const envelope = asRecord(body)
  if (envelope === undefined) return { ok: false, detail: "the versions response is not an object" }
  if (envelope.success === false) {
    return {
      ok: false,
      detail: `the versions API refused the call: ${preview(JSON.stringify(envelope.errors ?? envelope))}`
    }
  }
  const result = asRecord(envelope.result)
  const items = result?.items
  if (!Array.isArray(items)) {
    return {
      ok: false,
      detail: `the versions response carries no result.items array: ${preview(JSON.stringify(body))}`
    }
  }
  const versions: Array<WorkerVersion> = []
  for (const item of items) {
    const record = asRecord(item)
    const id = optionalString(record?.id)
    if (id === undefined) {
      return { ok: false, detail: `a version entry carries no id: ${preview(JSON.stringify(item))}` }
    }
    versions.push({
      id,
      createdOn: optionalString(asRecord(record?.metadata)?.created_on),
      message: optionalString(asRecord(record?.annotations)?.["workers/message"])
    })
  }
  return { ok: true, value: versions }
}

/** The versions the newest deployment splits traffic across. */
export const parseDeployedVersions = (body: unknown): Parsed<ReadonlyArray<DeployedVersion>> => {
  const envelope = asRecord(body)
  if (envelope === undefined) return { ok: false, detail: "the deployments response is not an object" }
  if (envelope.success === false) {
    return {
      ok: false,
      detail: `the deployments API refused the call: ${preview(JSON.stringify(envelope.errors ?? envelope))}`
    }
  }
  const deployments = asRecord(envelope.result)?.deployments
  if (!Array.isArray(deployments)) {
    return {
      ok: false,
      detail: `the deployments response carries no result.deployments array: ${preview(JSON.stringify(body))}`
    }
  }
  if (deployments.length === 0) return { ok: false, detail: "the Worker has no deployments" }
  const versions = asRecord(deployments[0])?.versions
  if (!Array.isArray(versions)) {
    return {
      ok: false,
      detail: `the newest deployment carries no versions array: ${preview(JSON.stringify(deployments[0]))}`
    }
  }
  const parsed: Array<DeployedVersion> = []
  for (const entry of versions) {
    const record = asRecord(entry)
    const id = optionalString(record?.version_id)
    const percentage = record?.percentage
    if (id === undefined || typeof percentage !== "number") {
      return { ok: false, detail: `a deployed version entry is malformed: ${preview(JSON.stringify(entry))}` }
    }
    parsed.push({ id, percentage })
  }
  return { ok: true, value: parsed }
}

/**
 * The receipt names a version at all. A `null` here is the CN-24 gap itself:
 * every receipt on disk records null because every recorded run was a dry run,
 * and `wrangler deploy --dry-run` returns before it prints a version id.
 */
export const receiptVerdict = (receipt: Receipt): Verdict => {
  if (receipt.dryRun) {
    return {
      ok: false,
      detail:
        `the receipt from ${receipt.timestamp} is a --dry-run: it published nothing, so it names no deployed version. Roll a real deploy before reading rollback readiness from it.`
    }
  }
  if (receipt.wranglerVersionId === null) {
    return {
      ok: false,
      detail:
        "the deploy receipt names no wranglerVersionId, so no version can be confirmed deployed or rolled back to."
    }
  }
  return {
    ok: true,
    detail: `the receipt from ${receipt.timestamp} (git ${
      receipt.gitSha.slice(0, 12)
    }) names version ${receipt.wranglerVersionId}`
  }
}

/** The version the receipt names is the one actually serving traffic. */
export const deployedVerdict = (deployed: ReadonlyArray<DeployedVersion>, receiptVersionId: string): Verdict => {
  const match = deployed.find((version) => version.id === receiptVersionId)
  if (match === undefined) {
    return {
      ok: false,
      detail: `the receipt names ${receiptVersionId} but the live deployment serves ${
        deployed.map((version) => `${version.id} (${version.percentage}%)`).join(", ") || "nothing"
      } — the deployment drifted from the receipt.`
    }
  }
  return { ok: true, detail: `${receiptVersionId} is serving ${match.percentage}% of traffic` }
}

/**
 * A prior version is still rollback-eligible. Cloudflare returns the version
 * list newest first, so "prior" is the entry AFTER the deployed one — not
 * merely the first entry that differs from it. The distinction matters when
 * the receipt has fallen behind the live deployment: picking the first
 * different entry would name a NEWER version as the rollback target.
 */
export const rollbackVerdict = (
  versions: ReadonlyArray<WorkerVersion>,
  deployedVersionId: string | null
): Verdict => {
  if (deployedVersionId === null) {
    return {
      ok: false,
      detail:
        "the deploy receipt names no wranglerVersionId, so no version can be confirmed deployed or rolled back to."
    }
  }
  if (versions.length < 2) {
    return {
      ok: false,
      detail: `only ${versions.length} version(s) exist for this Worker: there is nothing to roll back to.`
    }
  }
  const index = versions.findIndex((version) => version.id === deployedVersionId)
  if (index === -1) {
    return {
      ok: false,
      detail: `the receipt names version ${deployedVersionId}, which is not in Cloudflare's version list.`
    }
  }
  const prior = versions[index + 1]
  if (prior === undefined) {
    return {
      ok: false,
      detail:
        `${deployedVersionId} is the oldest version Cloudflare still lists: there is nothing older to roll back to.`
    }
  }
  return {
    ok: true,
    detail: `deployed ${deployedVersionId}; the previous version ${prior.id} (created ${
      prior.createdOn ?? "unknown"
    }) is still rollback-eligible — roll back with: bun x wrangler@4.123.0 rollback ${prior.id}`
  }
}
