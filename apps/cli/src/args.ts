import { getWebUrl, resolveDefaultWebBinding } from "./web"

export type UiTarget =
  | { kind: "dashboard" }
  | { kind: "run"; runId: string }
  | { kind: "node"; runId: string; nodeId: string }
  | { kind: "approvals" }

export type UiCommand = {
  kind: "ui"
  host: string
  port: number
  openWeb: boolean
  allowDiscovery: boolean
  target: UiTarget
}

export type BurnsCommand =
  | { kind: "help"; topic?: "start" | "daemon" | "web" | "ui" }
  | { kind: "daemon" }
  | { kind: "start"; host: string; port: number; openWeb: boolean; webUrl: string }
  | { kind: "web"; host: string; port: number; openWeb: boolean }
  | UiCommand

type ParseResult =
  | { ok: true; command: BurnsCommand }
  | { ok: false; error: string }

function parsePort(rawValue: string) {
  const parsedPort = Number(rawValue)
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return null
  }

  return parsedPort
}

function parseStartArgs(args: string[]): ParseResult {
  const defaults = resolveDefaultWebBinding()
  let host = defaults.host
  let port = defaults.port
  let openWeb = false
  let webUrl = getWebUrl(host, port)
  let webUrlWasExplicit = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === "--help" || arg === "-h") {
      return { ok: true, command: { kind: "help", topic: "start" } }
    }

    if (arg === "--open") {
      openWeb = true
      continue
    }

    if (arg === "--web-url") {
      const nextValue = args[index + 1]
      if (!nextValue) {
        return { ok: false, error: "Missing value for --web-url" }
      }

      webUrl = nextValue
      webUrlWasExplicit = true
      index += 1
      continue
    }

    if (arg === "--host") {
      const nextValue = args[index + 1]
      if (!nextValue) {
        return { ok: false, error: "Missing value for --host" }
      }

      host = nextValue
      if (!webUrlWasExplicit) {
        webUrl = getWebUrl(host, port)
      }
      index += 1
      continue
    }

    if (arg === "--port") {
      const nextValue = args[index + 1]
      if (!nextValue) {
        return { ok: false, error: "Missing value for --port" }
      }

      const parsedPort = parsePort(nextValue)
      if (!parsedPort) {
        return { ok: false, error: `Invalid --port value: ${nextValue}` }
      }

      port = parsedPort
      if (!webUrlWasExplicit) {
        webUrl = getWebUrl(host, port)
      }
      index += 1
      continue
    }

    return { ok: false, error: `Unknown option for burns start: ${arg}` }
  }

  return {
    ok: true,
    command: {
      kind: "start",
      host,
      port,
      openWeb,
      webUrl,
    },
  }
}

function parseDaemonArgs(args: string[]): ParseResult {
  if (args.length === 0) {
    return {
      ok: true,
      command: { kind: "daemon" },
    }
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return {
      ok: true,
      command: { kind: "help", topic: "daemon" },
    }
  }

  return { ok: false, error: `Unknown option for burns daemon: ${args[0]}` }
}

function parseWebArgs(args: string[]): ParseResult {
  const defaults = resolveDefaultWebBinding()
  let host = defaults.host
  let port = defaults.port
  let openWeb = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === "--help" || arg === "-h") {
      return { ok: true, command: { kind: "help", topic: "web" } }
    }

    if (arg === "--open") {
      openWeb = true
      continue
    }

    if (arg === "--host") {
      const nextValue = args[index + 1]
      if (!nextValue) {
        return { ok: false, error: "Missing value for --host" }
      }

      host = nextValue
      index += 1
      continue
    }

    if (arg === "--port") {
      const nextValue = args[index + 1]
      if (!nextValue) {
        return { ok: false, error: "Missing value for --port" }
      }

      const parsedPort = parsePort(nextValue)
      if (!parsedPort) {
        return { ok: false, error: `Invalid --port value: ${nextValue}` }
      }

      port = parsedPort
      index += 1
      continue
    }

    return { ok: false, error: `Unknown option for burns web: ${arg}` }
  }

  return {
    ok: true,
    command: {
      kind: "web",
      host,
      port,
      openWeb,
    },
  }
}

function parseUiTarget(positionals: string[]): ParseResult {
  if (positionals.length === 0) {
    return {
      ok: true,
      command: {
        kind: "ui",
        host: "",
        port: 0,
        openWeb: true,
        allowDiscovery: true,
        target: { kind: "dashboard" },
      },
    }
  }

  const [target, value] = positionals

  if (target === "approvals" && positionals.length === 1) {
    return {
      ok: true,
      command: {
        kind: "ui",
        host: "",
        port: 0,
        openWeb: true,
        allowDiscovery: true,
        target: { kind: "approvals" },
      },
    }
  }

  if (target === "run") {
    if (!value) {
      return { ok: false, error: "Missing run ID for burns ui run <run-id>" }
    }

    if (positionals.length > 2) {
      return { ok: false, error: `Unexpected argument for burns ui run: ${positionals[2]}` }
    }

    return {
      ok: true,
      command: {
        kind: "ui",
        host: "",
        port: 0,
        openWeb: true,
        allowDiscovery: true,
        target: { kind: "run", runId: value },
      },
    }
  }

  if (target === "node") {
    if (!value) {
      return { ok: false, error: "Missing run/node target for burns ui node <run-id>/<node-id>" }
    }

    if (positionals.length > 2) {
      return { ok: false, error: `Unexpected argument for burns ui node: ${positionals[2]}` }
    }

    const separatorIndex = value.indexOf("/")
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
      return {
        ok: false,
        error: "Invalid node target. Expected <run-id>/<node-id>",
      }
    }

    const runId = value.slice(0, separatorIndex)
    const nodeId = value.slice(separatorIndex + 1)
    return {
      ok: true,
      command: {
        kind: "ui",
        host: "",
        port: 0,
        openWeb: true,
        allowDiscovery: true,
        target: {
          kind: "node",
          runId,
          nodeId,
        },
      },
    }
  }

  return {
    ok: false,
    error: `Unknown UI target: ${target}`,
  }
}

function parseUiArgs(args: string[]): ParseResult {
  const defaults = resolveDefaultWebBinding()
  let host = defaults.host
  let port = defaults.port
  let openWeb = true
  let explicitHostOrPort = false
  const positionals: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === "--help" || arg === "-h") {
      return { ok: true, command: { kind: "help", topic: "ui" } }
    }

    if (arg === "--open") {
      openWeb = true
      continue
    }

    if (arg === "--no-open") {
      openWeb = false
      continue
    }

    if (arg === "--host") {
      const nextValue = args[index + 1]
      if (!nextValue) {
        return { ok: false, error: "Missing value for --host" }
      }

      host = nextValue
      explicitHostOrPort = true
      index += 1
      continue
    }

    if (arg === "--port") {
      const nextValue = args[index + 1]
      if (!nextValue) {
        return { ok: false, error: "Missing value for --port" }
      }

      const parsedPort = parsePort(nextValue)
      if (!parsedPort) {
        return { ok: false, error: `Invalid --port value: ${nextValue}` }
      }

      port = parsedPort
      explicitHostOrPort = true
      index += 1
      continue
    }

    if (arg.startsWith("-")) {
      return { ok: false, error: `Unknown option for burns ui: ${arg}` }
    }

    positionals.push(arg)
  }

  const parsedTarget = parseUiTarget(positionals)
  if (!parsedTarget.ok) {
    return parsedTarget
  }

  const target = (parsedTarget.command as UiCommand).target

  return {
    ok: true,
    command: {
      kind: "ui",
      host,
      port,
      openWeb,
      allowDiscovery: !explicitHostOrPort,
      target,
    },
  }
}

export function parseCliArgs(argv: string[]): ParseResult {
  if (argv.length === 0) {
    return {
      ok: true,
      command: {
        kind: "help",
      },
    }
  }

  const [commandName, ...commandArgs] = argv

  if (commandName === "--help" || commandName === "-h") {
    return {
      ok: true,
      command: {
        kind: "help",
      },
    }
  }

  if (commandName === "start") {
    return parseStartArgs(commandArgs)
  }

  if (commandName === "daemon") {
    return parseDaemonArgs(commandArgs)
  }

  if (commandName === "web") {
    return parseWebArgs(commandArgs)
  }

  if (commandName === "ui") {
    return parseUiArgs(commandArgs)
  }

  return {
    ok: false,
    error: `Unknown command: ${commandName}`,
  }
}
