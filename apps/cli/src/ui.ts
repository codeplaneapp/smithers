import { createConnection } from "node:net"

import { resolveDaemonApiUrl } from "./daemon"
import { resolveCliEntrypointPath } from "./paths"
import { getMissingWebBuildGuidance, getWebUrl, hasBuiltWebApp } from "./web"
import type { UiCommand, UiTarget } from "./args"

type ProbeState = {
  daemonHealthy: boolean
  webHealthy: boolean
}

export type EnsureUiHostResult =
  | {
      ok: true
      serverAutoStarted: boolean
      webBaseUrl: string
      daemonBaseUrl: string
    }
  | {
      ok: false
      error: string
      webBaseUrl: string
      daemonBaseUrl: string
    }

function mapProbeHost(host: string) {
  if (host === "0.0.0.0" || host === "::") {
    return "127.0.0.1"
  }

  return host
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function parseUrlHostAndPort(rawUrl: string) {
  try {
    const parsedUrl = new URL(rawUrl)
    const port = parsedUrl.port
      ? Number(parsedUrl.port)
      : parsedUrl.protocol === "https:"
        ? 443
        : 80

    if (!Number.isInteger(port) || port < 1) {
      return null
    }

    return {
      host: parsedUrl.hostname,
      port,
    }
  } catch {
    return null
  }
}

async function isPortInUse(host: string, port: number) {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({
      host: mapProbeHost(host),
      port,
    })

    let settled = false

    const finish = (value: boolean) => {
      if (settled) {
        return
      }

      settled = true
      socket.destroy()
      resolve(value)
    }

    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.once("timeout", () => finish(false))
    socket.setTimeout(400)
  })
}

async function fetchOk(url: string, timeoutMs = 1200) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    })

    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function probeDaemonHealth(daemonBaseUrl: string) {
  const healthUrl = new URL(
    "/api/health",
    `${daemonBaseUrl.replace(/\/+$/, "")}/`
  ).toString()
  return await fetchOk(healthUrl)
}

async function probeWebHealth(webBaseUrl: string) {
  const webHealthUrl = new URL(
    "/health",
    `${webBaseUrl.replace(/\/+$/, "")}/`
  ).toString()
  if (await fetchOk(webHealthUrl)) {
    return true
  }

  const rootUrl = new URL(
    "/",
    `${webBaseUrl.replace(/\/+$/, "")}/`
  ).toString()

  return await fetchOk(rootUrl)
}

async function probeHostState(webBaseUrl: string, daemonBaseUrl: string): Promise<ProbeState> {
  const [daemonHealthy, webHealthy] = await Promise.all([
    probeDaemonHealth(daemonBaseUrl),
    probeWebHealth(webBaseUrl),
  ])

  return {
    daemonHealthy,
    webHealthy,
  }
}

function parseDiscoveryPorts(rawValue: string | undefined) {
  if (!rawValue) {
    return []
  }

  return rawValue
    .split(",")
    .map((segment) => segment.trim())
    .map((segment) => Number(segment))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
}

async function discoverExistingWebBaseUrl(
  host: string,
  defaultPort: number,
  daemonBaseUrl: string
) {
  const probeHosts = Array.from(
    new Set([host, mapProbeHost(host), "127.0.0.1", "localhost"])
  )
  const probePorts = Array.from(
    new Set<number>([
      defaultPort,
      ...parseDiscoveryPorts(process.env.BURNS_UI_DISCOVERY_PORTS),
      9999,
    ])
  )

  for (const probeHost of probeHosts) {
    for (const probePort of probePorts) {
      const candidateBaseUrl = getWebUrl(probeHost, probePort)
      const state = await probeHostState(candidateBaseUrl, daemonBaseUrl)
      if (state.webHealthy && state.daemonHealthy) {
        return candidateBaseUrl
      }
    }
  }

  return null
}

function spawnDetachedCli(commandArgs: string[]) {
  const child = Bun.spawn([process.execPath, resolveCliEntrypointPath(), ...commandArgs], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
    env: process.env,
  })

  child.unref()
}

async function waitForUiHostHealthy(
  webBaseUrl: string,
  daemonBaseUrl: string,
  timeoutMs = 12_000
) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    const state = await probeHostState(webBaseUrl, daemonBaseUrl)
    if (state.daemonHealthy && state.webHealthy) {
      return true
    }

    await sleep(250)
  }

  return false
}

export async function ensureUiHostRunning(command: Pick<UiCommand, "host" | "port" | "allowDiscovery">): Promise<EnsureUiHostResult> {
  const daemonBaseUrl = resolveDaemonApiUrl()
  let webBaseUrl = getWebUrl(command.host, command.port)
  let state = await probeHostState(webBaseUrl, daemonBaseUrl)

  if (!state.webHealthy && command.allowDiscovery) {
    const discoveredWebBaseUrl = await discoverExistingWebBaseUrl(
      command.host,
      command.port,
      daemonBaseUrl
    )

    if (discoveredWebBaseUrl) {
      webBaseUrl = discoveredWebBaseUrl
      state = await probeHostState(webBaseUrl, daemonBaseUrl)
    }
  }

  if (state.daemonHealthy && state.webHealthy) {
    return {
      ok: true,
      serverAutoStarted: false,
      webBaseUrl,
      daemonBaseUrl,
    }
  }

  if (!state.webHealthy && !(await hasBuiltWebApp())) {
    return {
      ok: false,
      error: getMissingWebBuildGuidance(),
      webBaseUrl,
      daemonBaseUrl,
    }
  }

  if (!state.daemonHealthy) {
    const daemonHostAndPort = parseUrlHostAndPort(daemonBaseUrl)
    if (daemonHostAndPort && (await isPortInUse(daemonHostAndPort.host, daemonHostAndPort.port))) {
      return {
        ok: false,
        error: `Port ${daemonHostAndPort.port} is in use`,
        webBaseUrl,
        daemonBaseUrl,
      }
    }
  }

  if (!state.webHealthy) {
    const webHostAndPort = parseUrlHostAndPort(webBaseUrl)
    if (webHostAndPort && (await isPortInUse(webHostAndPort.host, webHostAndPort.port))) {
      return {
        ok: false,
        error: `Port ${webHostAndPort.port} is in use`,
        webBaseUrl,
        daemonBaseUrl,
      }
    }
  }

  const startupCommandArgs =
    !state.daemonHealthy && !state.webHealthy
      ? ["start", "--host", command.host, "--port", String(command.port)]
      : !state.daemonHealthy
        ? ["daemon"]
        : ["web", "--host", command.host, "--port", String(command.port)]

  try {
    spawnDetachedCli(startupCommandArgs)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      webBaseUrl,
      daemonBaseUrl,
    }
  }

  const healthy = await waitForUiHostHealthy(webBaseUrl, daemonBaseUrl)
  if (!healthy) {
    return {
      ok: false,
      error: "Timed out waiting for UI host to start",
      webBaseUrl,
      daemonBaseUrl,
    }
  }

  return {
    ok: true,
    serverAutoStarted: true,
    webBaseUrl,
    daemonBaseUrl,
  }
}

export function shouldSuppressAutoOpen(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
) {
  if (env.BURNS_UI_NO_OPEN === "1") {
    return true
  }

  if (env.CI) {
    return true
  }

  const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
  const isSshSession = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT)

  if (platform === "linux" && !hasDisplay) {
    return true
  }

  if (isSshSession && !hasDisplay) {
    return true
  }

  return false
}

export function buildUiPath(target: UiTarget) {
  switch (target.kind) {
    case "dashboard":
      return "/runs"
    case "run":
      return `/runs/${encodeURIComponent(target.runId)}`
    case "node":
      return `/runs/${encodeURIComponent(target.runId)}/nodes/${encodeURIComponent(target.nodeId)}`
    case "approvals":
      return "/approvals"
  }
}

function buildUiSearchParams(target: UiTarget) {
  const params = new URLSearchParams()

  switch (target.kind) {
    case "dashboard":
      params.set("tab", "runs")
      break
    case "run":
      params.set("tab", "runs")
      params.set("runId", target.runId)
      break
    case "node":
      params.set("tab", "runs")
      params.set("runId", target.runId)
      params.set("nodeId", target.nodeId)
      break
    case "approvals":
      params.set("tab", "approvals")
      break
  }

  return params
}

export function buildUiUrl(webBaseUrl: string, target: UiTarget) {
  const normalizedBaseUrl = `${webBaseUrl.replace(/\/+$/, "")}/`
  const url = new URL(buildUiPath(target), normalizedBaseUrl)
  const searchParams = buildUiSearchParams(target)
  url.search = searchParams.toString()
  return url.toString()
}
