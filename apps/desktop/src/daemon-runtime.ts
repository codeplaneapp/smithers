import { startDaemon, type DaemonRuntimeHandle } from "../../daemon/src/bootstrap/daemon-lifecycle"

export const DEFAULT_DESKTOP_DAEMON_URL = "http://localhost:7332"
export const DAEMON_HEALTH_PATH = "/api/health"

export type DesktopDaemonRuntimeHandle = {
  source: "spawned" | "existing"
  url: string
  stop: () => Promise<void>
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type ResolveDesktopDaemonRuntimeOptions = {
  daemonUrlEnv?: string
  fetchImpl?: FetchLike
  start?: () => Promise<DaemonRuntimeHandle>
}

function parseDaemonUrl(candidate: string | undefined): string | null {
  const rawValue = candidate?.trim()
  if (!rawValue) {
    return null
  }

  try {
    const parsed = new URL(rawValue)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return rawValue
    }
  } catch {
    // Ignore invalid values.
  }

  return null
}

function buildDaemonUrlCandidates(rawDaemonUrl: string | undefined): string[] {
  const parsedDaemonUrl = parseDaemonUrl(rawDaemonUrl)
  if (!parsedDaemonUrl || parsedDaemonUrl === DEFAULT_DESKTOP_DAEMON_URL) {
    return [DEFAULT_DESKTOP_DAEMON_URL]
  }

  return [parsedDaemonUrl, DEFAULT_DESKTOP_DAEMON_URL]
}

function toHealthUrl(baseUrl: string): string {
  return new URL(DAEMON_HEALTH_PATH, baseUrl).toString()
}

async function isDaemonHealthy(baseUrl: string, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const response = await fetchImpl(toHealthUrl(baseUrl), {
      method: "GET",
      headers: {
        "cache-control": "no-cache",
      },
    })

    return response.ok
  } catch {
    return false
  }
}

async function findReachableDaemonUrl(
  candidates: string[],
  fetchImpl: FetchLike,
  options: { attempts?: number; retryDelayMs?: number } = {}
): Promise<string | null> {
  const attempts = Math.max(1, options.attempts ?? 1)
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0)

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const candidate of candidates) {
      if (await isDaemonHealthy(candidate, fetchImpl)) {
        return candidate
      }
    }

    if (attempt + 1 < attempts && retryDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDelayMs)
      })
    }
  }

  return null
}

function isAddressInUseError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
    return true
  }

  if (!(error instanceof Error)) {
    return false
  }

  return /EADDRINUSE|port\s+\d+\s+in use/i.test(error.message)
}

function buildExternalDaemonRuntime(url: string): DesktopDaemonRuntimeHandle {
  return {
    source: "existing",
    url,
    stop: async () => {},
  }
}

export async function resolveDesktopDaemonRuntime(
  options: ResolveDesktopDaemonRuntimeOptions = {}
): Promise<DesktopDaemonRuntimeHandle> {
  const fetchImpl = options.fetchImpl ?? fetch
  const start = options.start ?? startDaemon
  const candidates = buildDaemonUrlCandidates(
    options.daemonUrlEnv ?? process.env.BURNS_DESKTOP_DAEMON_URL
  )

  const existingDaemonUrl = await findReachableDaemonUrl(candidates, fetchImpl)
  if (existingDaemonUrl) {
    return buildExternalDaemonRuntime(existingDaemonUrl)
  }

  try {
    const runtime = await start()
    return {
      source: "spawned",
      url: runtime.url,
      stop: runtime.stop,
    }
  } catch (error) {
    if (!isAddressInUseError(error)) {
      throw error
    }

    const daemonUrlAfterPortConflict = await findReachableDaemonUrl(candidates, fetchImpl, {
      attempts: 5,
      retryDelayMs: 250,
    })
    if (daemonUrlAfterPortConflict) {
      return buildExternalDaemonRuntime(daemonUrlAfterPortConflict)
    }

    throw error
  }
}
