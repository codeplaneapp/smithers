/*
 * The repo-import seam: POST /api/github/import {owner, repo} starts the job;
 * GET /api/github/import/{jobId} polls it. Progress lives on one upserted
 * "repo-import" card (phase starting → running → done | failed). Reference:
 * multi src/smithersCloud/githubImport.ts (startImport/pollImport) against
 * plue internal/routes/github_import.go.
 */
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage } from "./SeamContext"

export interface RepoImportSeam {
  readonly importRepository: (repo?: string) => Promise<string | void>
}

/**
 * Poll cadence knobs, module-level so tests can shorten the wait: one status
 * check every `delayMs`, at most `maxAttempts` checks, and `networkRetries`
 * consecutive failed polls tolerated before the loop stops tracking.
 */
export const repoImportPolling = {
  delayMs: 2_000,
  maxAttempts: 60,
  networkRetries: 2
}

/** The honest sign-off when polling can no longer see the job. */
export const REPO_IMPORT_LOST_STREAM_DETAIL = "lost the import stream — run /repos.import again to re-check"

type ImportPhase = "starting" | "running" | "done" | "failed"

/** Plue's import job answer, reduced to what the card tracks. The wire shape
 *  is the reference's ImportJob: {importJobId, status, stage?, error?, …}. */
interface ImportJobAnswer {
  readonly jobId: string
  readonly status: "cloning" | "ready" | "failed"
  readonly stage: string | null
  readonly error: string | null
}

const parseImportJob = (body: unknown): ImportJobAnswer | null => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null
  const job = body as Record<string, unknown>
  const jobId = job.importJobId
  const status = job.status
  if (typeof jobId !== "string" || jobId === "") return null
  if (status !== "cloning" && status !== "ready" && status !== "failed") return null
  return {
    jobId,
    status,
    stage: typeof job.stage === "string" && job.stage !== "" ? job.stage : null,
    error: typeof job.error === "string" && job.error !== "" ? job.error : null
  }
}

/** Human detail per in-flight stage — the reference's importStageDetail map. */
const STAGE_DETAIL: Readonly<Record<string, string>> = {
  resolving: "Contacting GitHub…",
  creating_repo: "Creating mirror…",
  cloning_github: "Downloading from GitHub…",
  pushing_mirror: "Uploading to Smithers Cloud…",
  importing_refs: "Importing branches…",
  creating_bookmark: "Preparing default branch…",
  provisioning_workspace: "Provisioning workspace…"
}

const stageDetail = (job: ImportJobAnswer): string | null =>
  job.status === "cloning" && job.stage !== null ? (STAGE_DETAIL[job.stage] ?? null) : null

const cardStatus = (phase: ImportPhase): "active" | "acted" | "error" =>
  phase === "done" ? "acted" : phase === "failed" ? "error" : "active"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const createRepoImportSeam = (ctx: SeamContext): RepoImportSeam => {
  /*
   * One tracking loop per repo: a re-run (the card's "Try again", or the
   * command again) bumps the epoch so a superseded loop stops upserting a
   * card the new run now owns.
   */
  const epochs = new Map<string, number>()

  const upsert = (
    repo: string,
    ordinal: number,
    createdAt: number,
    jobId: string | null,
    phase: ImportPhase,
    detail: string | null
  ): void => {
    const card: Card = {
      id: `repo-import-${repo}`,
      kind: "repo-import",
      title: `Import · ${repo}`,
      status: cardStatus(phase),
      createdAt,
      // The creation-time ordinal, passed unchanged on every upsert so the
      // card never jumps around the transcript while the job progresses.
      ordinal,
      payload: { repo, jobId, phase, detail }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  const track = async (
    repo: string,
    jobId: string,
    ordinal: number,
    createdAt: number,
    epoch: number
  ): Promise<void> => {
    /*
     * The epochs map exists to supersede stale loops; an entry whose loop
     * has reached a terminal hand-off is dead weight retained per repo for
     * the session's life. Every terminal branch below settles it, guarded
     * so a re-run's newer epoch is never deleted out from under it (a
     * deleted entry reads as !== any stale epoch, which is the same stop
     * signal the supersede check already relies on).
     */
    const settleEpoch = (): void => {
      if (epochs.get(repo) === epoch) epochs.delete(repo)
    }
    let failures = 0
    for (let attempt = 0; attempt < repoImportPolling.maxAttempts; attempt += 1) {
      await sleep(repoImportPolling.delayMs)
      if (epochs.get(repo) !== epoch) return
      let job: ImportJobAnswer | null = null
      try {
        const response = await ctx.http(
          `${ctx.baseUrl}/api/github/import/${encodeURIComponent(jobId)}`
        )
        if (response.ok) job = parseImportJob(await response.json().catch(() => undefined))
      } catch {
        // A dropped poll is retried below; the job keeps running upstream.
      }
      if (epochs.get(repo) !== epoch) return
      if (job === null) {
        failures += 1
        if (failures <= repoImportPolling.networkRetries) continue
        upsert(repo, ordinal, createdAt, jobId, "running", REPO_IMPORT_LOST_STREAM_DETAIL)
        settleEpoch()
        return
      }
      failures = 0
      if (job.status === "ready") {
        upsert(repo, ordinal, createdAt, jobId, "done", null)
        settleEpoch()
        return
      }
      if (job.status === "failed") {
        upsert(repo, ordinal, createdAt, jobId, "failed", job.error ?? "The import failed upstream.")
        settleEpoch()
        return
      }
      upsert(repo, ordinal, createdAt, jobId, "running", stageDetail(job) ?? job.error)
    }
    // Attempts exhausted without a terminal status: same honest hand-off as a
    // lost stream — the command re-checks the job when run again.
    upsert(repo, ordinal, createdAt, jobId, "running", REPO_IMPORT_LOST_STREAM_DETAIL)
    settleEpoch()
  }

  const importRepository = async (explicit?: string): Promise<string | void> => {
    const resolved = resolveTargetRepo(ctx.store, explicit)
    if ("error" in resolved) return resolved.error
    const repo = resolved.repo
    const [owner, name] = repo.split("/") as [string, string]

    const ordinal = ctx.nextOrdinal()
    const createdAt = Date.now()
    const epoch = (epochs.get(repo) ?? 0) + 1
    epochs.set(repo, epoch)
    upsert(repo, ordinal, createdAt, null, "starting", null)
    /*
     * A start that ends without a tracking loop (every branch that returns
     * before `track` below) has a terminal epoch: settle it the same way
     * the loop's own terminal branches do, or one dead entry accumulates
     * per imported repo for the session.
     */
    const settleEpoch = (): void => {
      if (epochs.get(repo) === epoch) epochs.delete(repo)
    }

    let response: Response
    try {
      response = await ctx.http(`${ctx.baseUrl}/api/github/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner, repo: name })
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const message = `The import couldn't start — ${reason}`
      upsert(repo, ordinal, createdAt, null, "failed", message)
      settleEpoch()
      return message
    }
    if (response.status === 409) {
      // Plue's conflict verdicts ("repository already exists",
      // "github_import_already_active") both mean the mirror is already
      // there or already on its way — stated honestly, not failed.
      upsert(repo, ordinal, createdAt, null, "done", "already imported")
      settleEpoch()
      return undefined
    }
    if (!response.ok) {
      const message = await readErrorMessage(
        response,
        `The import couldn't start (HTTP ${response.status})`
      )
      upsert(repo, ordinal, createdAt, null, "failed", message)
      settleEpoch()
      return message
    }
    const job = parseImportJob(await response.json().catch(() => undefined))
    if (job === null) {
      const message = "The import answer was malformed — the job id never arrived."
      upsert(repo, ordinal, createdAt, null, "failed", message)
      settleEpoch()
      return message
    }
    if (job.status === "ready") {
      upsert(repo, ordinal, createdAt, job.jobId, "done", "already imported")
      settleEpoch()
      return undefined
    }
    if (job.status === "failed") {
      const message = job.error ?? "The import failed upstream."
      upsert(repo, ordinal, createdAt, job.jobId, "failed", message)
      settleEpoch()
      return message
    }
    upsert(repo, ordinal, createdAt, job.jobId, "running", stageDetail(job))
    // Fire-and-forget: the job started and the card tracks it — success now.
    void track(repo, job.jobId, ordinal, createdAt, epoch)
    return undefined
  }

  return { importRepository }
}
