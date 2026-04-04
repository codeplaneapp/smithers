import { access } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { resolveDaemonLifecyclePath } from "./paths"

export const DEFAULT_DAEMON_API_URL = "http://localhost:7332"

export function resolveDaemonApiUrl(env: NodeJS.ProcessEnv = process.env) {
  const configuredUrl = env.BURNS_DAEMON_API_URL?.trim()
  if (!configuredUrl) {
    return DEFAULT_DAEMON_API_URL
  }

  try {
    const parsed = new URL(configuredUrl)
    parsed.pathname = ""
    parsed.search = ""
    parsed.hash = ""
    return parsed.toString().replace(/\/$/, "")
  } catch {
    return DEFAULT_DAEMON_API_URL
  }
}

function ensureCliRuntimeMode() {
  if (!process.env.BURNS_RUNTIME_MODE) {
    process.env.BURNS_RUNTIME_MODE = "cli"
  }
}

async function ensureEntrypointExists(entrypointPath: string) {
  try {
    await access(entrypointPath)
  } catch {
    throw new Error(
      [
        `Daemon entrypoint not found at ${entrypointPath}.`,
        "Run this command from the Burns repository checkout.",
      ].join(" ")
    )
  }
}

type DaemonRuntimeHandle = {
  url: string
  stop: () => Promise<void>
}

type DaemonLifecycleModule = {
  startDaemon: () => Promise<DaemonRuntimeHandle>
}

function isDaemonLifecycleModule(value: unknown): value is DaemonLifecycleModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { startDaemon?: unknown }).startDaemon === "function"
  )
}

export async function startDaemonFromLifecycle() {
  ensureCliRuntimeMode()
  const lifecyclePath = resolveDaemonLifecyclePath()
  await ensureEntrypointExists(lifecyclePath)

  const module = (await import(pathToFileURL(lifecyclePath).href)) as unknown
  if (!isDaemonLifecycleModule(module)) {
    throw new Error(`Invalid daemon lifecycle module at ${lifecyclePath}`)
  }

  const runtime = await module.startDaemon()

  return {
    apiUrl: runtime.url || resolveDaemonApiUrl(),
    stopDaemon: runtime.stop,
  }
}
