import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Workspace } from "@mr-burns/shared"

import {
  DEFAULT_SMITHERS_BASE_URL,
  DEFAULT_SMITHERS_MAX_WORKSPACE_INSTANCES,
  DEFAULT_SMITHERS_PORT_BASE,
} from "@/config/app-config"
import { getLogger } from "@/logging/logger"

type SmithersInstanceStatus = "starting" | "healthy" | "crashed" | "stopped"

type SmithersInstanceRecord = {
  workspace: Workspace
  workspaceId: string
  port: number | null
  baseUrl: string | null
  dbPath: string | null
  process: ChildProcess | null
  status: SmithersInstanceStatus
  crashCount: number
  startPromise?: Promise<void>
  restartTimer?: ReturnType<typeof setTimeout>
  stopRequested: boolean
}

const logger = getLogger().child({ component: "smithers.instance.service" })

const managedModeEnabled =
  process.env.BURNS_SMITHERS_MANAGED_MODE !== "0" && process.env.NODE_ENV !== "test"

const runnerScriptPath = fileURLToPath(new URL("../jobs/smithers-server-runner.ts", import.meta.url))
const instances = new Map<string, SmithersInstanceRecord>()

let shuttingDown = false

function parseEnvInt(rawValue: string | undefined, fallback: number, min: number) {
  if (!rawValue) {
    return fallback
  }

  const parsed = Number(rawValue)
  if (!Number.isInteger(parsed) || parsed < min) {
    return fallback
  }

  return parsed
}

function parseBoolean(value: string | undefined) {
  if (!value) {
    return false
  }

  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

function sleep(durationMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs)
    timer.unref()
  })
}

function resolveBunExecutable() {
  const bunBinary =
    typeof Bun !== "undefined" && typeof Bun.which === "function" ? Bun.which("bun") : undefined

  return bunBinary ?? process.execPath
}

function resolveFallbackBaseUrl() {
  return process.env.BURNS_SMITHERS_BASE_URL ?? DEFAULT_SMITHERS_BASE_URL
}

function getSmithersPortBase() {
  return parseEnvInt(process.env.BURNS_SMITHERS_PORT_BASE, DEFAULT_SMITHERS_PORT_BASE, 1)
}

function getMaxWorkspaceInstances() {
  return parseEnvInt(
    process.env.BURNS_SMITHERS_MAX_WORKSPACE_INSTANCES,
    DEFAULT_SMITHERS_MAX_WORKSPACE_INSTANCES,
    1
  )
}

function isPortAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.unref()

    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })

    server.listen(port)
  })
}

async function allocatePort(record: SmithersInstanceRecord) {
  const portBase = getSmithersPortBase()
  const maxInstances = getMaxWorkspaceInstances()
  const usedPorts = new Set<number>()

  for (const [workspaceId, instance] of instances.entries()) {
    if (workspaceId === record.workspaceId) {
      continue
    }

    if (instance.port !== null && instance.status !== "stopped") {
      usedPorts.add(instance.port)
    }
  }

  if (record.port !== null && !usedPorts.has(record.port)) {
    const samePortAvailable = await isPortAvailable(record.port)
    if (samePortAvailable) {
      return record.port
    }
  }

  for (let offset = 0; offset < maxInstances; offset += 1) {
    const candidate = portBase + offset
    if (usedPorts.has(candidate)) {
      continue
    }

    const available = await isPortAvailable(candidate)
    if (available) {
      record.port = candidate
      return candidate
    }
  }

  throw new Error("No available Smithers port found for workspace instance")
}

async function waitForHealthy(baseUrl: string, timeoutMs = 12_000) {
  const deadlineMs = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadlineMs) {
    try {
      const response = await fetch(`${baseUrl}/v1/runs?limit=1`)
      if (response.ok) {
        return
      }

      lastError = new Error(`Health check returned status ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await sleep(200)
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for Smithers server")
}

function computeRestartDelayMs(crashCount: number) {
  const boundedCrashCount = Math.min(Math.max(crashCount, 1), 6)
  return Math.min(30_000, 1_000 * 2 ** (boundedCrashCount - 1))
}

function wireProcessLogs(record: SmithersInstanceRecord, child: ChildProcess) {
  child.stdout?.on("data", (chunk: Buffer | string) => {
    const lines = String(chunk)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)

    for (const line of lines) {
      logger.debug(
        {
          event: "smithers.instance.stdout",
          workspaceId: record.workspaceId,
          pid: child.pid,
          line,
        },
        "Smithers workspace stdout"
      )
    }
  })

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const lines = String(chunk)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)

    for (const line of lines) {
      logger.warn(
        {
          event: "smithers.instance.stderr",
          workspaceId: record.workspaceId,
          pid: child.pid,
          line,
        },
        "Smithers workspace stderr"
      )
    }
  })
}

function scheduleRestart(record: SmithersInstanceRecord) {
  if (record.restartTimer || shuttingDown || record.stopRequested) {
    return
  }

  record.crashCount += 1
  const delayMs = computeRestartDelayMs(record.crashCount)
  record.restartTimer = setTimeout(() => {
    record.restartTimer = undefined
    void startRecord(record).catch((error) => {
      logger.error(
        {
          event: "smithers.instance.restart_failed",
          workspaceId: record.workspaceId,
          err: error,
        },
        "Failed restarting Smithers workspace process"
      )
    })
  }, delayMs)

  record.restartTimer.unref()

  logger.warn(
    {
      event: "smithers.instance.restart_scheduled",
      workspaceId: record.workspaceId,
      delayMs,
      crashCount: record.crashCount,
    },
    "Scheduled Smithers workspace restart"
  )
}

function onProcessExit(record: SmithersInstanceRecord, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
  if (record.process?.pid === child.pid) {
    record.process = null
  }

  if (record.stopRequested || shuttingDown) {
    record.status = "stopped"
    return
  }

  record.status = "crashed"

  logger.warn(
    {
      event: "smithers.instance.exited",
      workspaceId: record.workspaceId,
      pid: child.pid,
      code,
      signal,
    },
    "Smithers workspace process exited unexpectedly"
  )

  scheduleRestart(record)
}

function getDbPath(workspacePath: string) {
  return path.join(workspacePath, ".mr-burns", "state", "smithers.sqlite")
}

async function startRecord(record: SmithersInstanceRecord) {
  if (
    record.process &&
    record.status === "healthy" &&
    record.process.exitCode === null &&
    record.process.signalCode === null
  ) {
    return
  }

  if (record.startPromise) {
    await record.startPromise
    return
  }

  record.startPromise = (async () => {
    record.stopRequested = false
    if (record.restartTimer) {
      clearTimeout(record.restartTimer)
      record.restartTimer = undefined
    }

    if (!existsSync(record.workspace.path)) {
      throw new Error(`Workspace path does not exist: ${record.workspace.path}`)
    }

    const port = await allocatePort(record)
    const dbPath = getDbPath(record.workspace.path)
    const baseUrl = `http://127.0.0.1:${port}`
    const env = {
      ...process.env,
      BURNS_SMITHERS_WORKSPACE_ID: record.workspaceId,
      BURNS_SMITHERS_WORKSPACE_PATH: record.workspace.path,
      BURNS_SMITHERS_DB_PATH: dbPath,
      BURNS_SMITHERS_PORT: String(port),
      BURNS_SMITHERS_ALLOW_NETWORK: process.env.BURNS_SMITHERS_ALLOW_NETWORK ?? "0",
      BURNS_DAEMON_PID: String(process.pid),
    } satisfies NodeJS.ProcessEnv

    mkdirSync(path.dirname(dbPath), { recursive: true })

    const child = spawn(resolveBunExecutable(), [runnerScriptPath], {
      cwd: record.workspace.path,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    record.process = child
    record.dbPath = dbPath
    record.baseUrl = baseUrl
    record.status = "starting"

    wireProcessLogs(record, child)
    child.once("exit", (code, signal) => onProcessExit(record, child, code, signal))
    child.once("error", (error) => {
      logger.error(
        {
          event: "smithers.instance.process_error",
          workspaceId: record.workspaceId,
          pid: child.pid,
          err: error,
        },
        "Smithers workspace process emitted error"
      )
    })

    logger.info(
      {
        event: "smithers.instance.starting",
        workspaceId: record.workspaceId,
        workspacePath: record.workspace.path,
        port,
      },
      "Starting Smithers workspace process"
    )

    try {
      await waitForHealthy(baseUrl)
      record.status = "healthy"
      record.crashCount = 0
    } catch (error) {
      if (record.process?.pid === child.pid) {
        record.process.kill("SIGTERM")
      }

      record.status = "crashed"
      scheduleRestart(record)
      throw error
    }
  })()

  try {
    await record.startPromise
  } finally {
    record.startPromise = undefined
  }
}

function getOrCreateRecord(workspace: Workspace) {
  const existing = instances.get(workspace.id)
  if (existing) {
    existing.workspace = workspace
    return existing
  }

  const record: SmithersInstanceRecord = {
    workspace,
    workspaceId: workspace.id,
    port: null,
    baseUrl: null,
    dbPath: null,
    process: null,
    status: "stopped",
    crashCount: 0,
    stopRequested: false,
  }
  instances.set(workspace.id, record)
  return record
}

async function stopProcess(child: ChildProcess, timeoutMs = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  await new Promise<void>((resolve) => {
    let finished = false
    const finish = () => {
      if (finished) {
        return
      }

      finished = true
      resolve()
    }

    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
      }
      finish()
    }, timeoutMs)

    timer.unref()

    child.once("exit", () => {
      clearTimeout(timer)
      finish()
    })

    child.kill("SIGTERM")
  })
}

export function isWorkspaceSmithersManaged() {
  return managedModeEnabled
}

export function getSmithersBaseUrlSettingValue() {
  return managedModeEnabled ? "managed-per-workspace (daemon-supervised)" : resolveFallbackBaseUrl()
}

export function startWorkspaceSmithersInBackground(workspace: Workspace) {
  if (workspace.runtimeMode === "self-managed") {
    return
  }

  if (!managedModeEnabled) {
    return
  }

  void ensureWorkspaceSmithersBaseUrl(workspace).catch((error) => {
    logger.error(
      {
        event: "smithers.instance.start_background_failed",
        workspaceId: workspace.id,
        err: error,
      },
      "Failed starting workspace Smithers instance in background"
    )
  })
}

export async function ensureWorkspaceSmithersBaseUrl(workspace: Workspace) {
  if (workspace.runtimeMode === "self-managed") {
    if (!workspace.smithersBaseUrl) {
      throw new Error(`Self-managed workspace ${workspace.id} is missing smithersBaseUrl`)
    }

    return workspace.smithersBaseUrl
  }

  if (!managedModeEnabled) {
    return resolveFallbackBaseUrl()
  }

  const record = getOrCreateRecord(workspace)
  await startRecord(record)
  if (!record.baseUrl) {
    throw new Error(`No Smithers base URL available for workspace ${workspace.id}`)
  }

  return record.baseUrl
}

export async function warmWorkspaceSmithersInstances(workspaces: Workspace[]) {
  if (!managedModeEnabled || workspaces.length === 0) {
    return
  }

  const managedWorkspaces = workspaces.filter((workspace) => workspace.runtimeMode !== "self-managed")
  const existingWorkspacePaths = managedWorkspaces.filter((workspace) => existsSync(workspace.path))
  const skippedCount = managedWorkspaces.length - existingWorkspacePaths.length

  if (existingWorkspacePaths.length === 0) {
    return
  }

  if (skippedCount > 0) {
    logger.info(
      {
        event: "smithers.instance.warm_skipped_disconnected",
        skippedCount,
        total: managedWorkspaces.length,
      },
      "Skipped warming disconnected workspaces"
    )
  }

  const results = await Promise.allSettled(
    existingWorkspacePaths.map(async (workspace) => {
      await ensureWorkspaceSmithersBaseUrl(workspace)
    })
  )

  const failedCount = results.filter((result) => result.status === "rejected").length
  if (failedCount > 0) {
    logger.warn(
      {
        event: "smithers.instance.warm_partial_failure",
        failedCount,
        total: existingWorkspacePaths.length,
      },
      "Failed to warm one or more Smithers workspace instances"
    )
  }
}

export async function shutdownWorkspaceSmithersInstances() {
  shuttingDown = true

  const stopTasks = [...instances.values()].map(async (record) => {
    record.stopRequested = true

    if (record.restartTimer) {
      clearTimeout(record.restartTimer)
      record.restartTimer = undefined
    }

    const child = record.process
    record.process = null

    if (child) {
      await stopProcess(child)
    }

    record.status = "stopped"
  })

  await Promise.allSettled(stopTasks)
}
