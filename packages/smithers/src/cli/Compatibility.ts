/**
 * Hidden transition aliases; canonical commands are the only advertised surface.
 * @since 1.0.0
 */
import { removedVerbs } from "../Unsupported.ts"

const restored = new Set(["graph", "eval", "review", "test", "runs", "show"])
const legacy = new Set([
  ...removedVerbs.filter((verb) => !restored.has(verb.name)).map((verb) => verb.name),
  "up",
  "plan",
  "approve",
  "deny",
  "ps",
  "ls",
  "logs",
  "events",
  "output",
  "cancel",
  "signal",
  "steer",
  "down",
  "resume",
  "status",
  "inspect",
  "why",
  "workflow",
  "gateway",
  "claude"
])
const valued = new Set(["--root", "--remote", "--credential", "--mcp-config", "--backend", "--audience", "--format"])
const switches = new Set(["--json", "--quiet", "--silent", "--verbose"])

/**
 * Route only unambiguous old spellings, retaining their existing output contracts.
 * @category constructors
 * @since 1.0.0
 */
export const legacyArguments = (args: ReadonlyArray<string>): Array<string> | undefined => {
  let index = 0
  while (index < args.length && args[index]!.startsWith("-")) {
    const flag = args[index]!
    if (switches.has(flag) || [...valued].some((value) => flag.startsWith(`${value}=`))) index++
    else if (valued.has(flag)) index += 2
    else return undefined
  }
  const command = args[index]
  if (command === "init" && args.slice(index + 1).some((arg) => arg === "--global" || arg.startsWith("--global="))) {
    return [...args]
  }
  if (command === "internal" && args[index + 1] === "claude") return [...args.slice(0, index), ...args.slice(index + 1)]
  // Preserve the existing no-input refusal without constructing either runtime.
  if ((command === "memory" || command === "mcp" || command === "bug") && args.length === index + 1) return [...args]
  if (
    command === "memory" && ((args[index + 1] === "get" && args.length === index + 2) ||
      (args[index + 1] === "set" && args.length === index + 3))
  ) return [...args]
  if (command !== undefined && legacy.has(command)) return [...args]
  if (command === "run") {
    const rest = args.slice(index + 1)
    if (rest.some((arg) => arg === "--resume" || arg.startsWith("--resume=")) || rest[0]?.trimStart().startsWith("{")) {
      return [...args]
    }
  }
  return undefined
}

/**
 * Modern log formatting and pagination use the canonical streaming command.
 * @category parsing
 * @since 1.0.0
 */
export const formattedLogArguments = (args: ReadonlyArray<string>): Array<string> | undefined => {
  let index = 0
  while (index < args.length && args[index]!.startsWith("-")) {
    const flag = args[index]!
    if (switches.has(flag) || [...valued].some((value) => flag.startsWith(`${value}=`))) index++
    else if (valued.has(flag)) index += 2
    else return undefined
  }
  if (
    args[index] !== "logs" ||
    args.some((arg) => arg === "--json" || arg === "--backend" || arg.startsWith("--backend="))
  ) return undefined
  if (!args.some((arg) => ["--format", "--after", "--limit"].includes(arg.split("=")[0]!))) return undefined
  return ["runs", "logs", ...args.slice(0, index), ...args.slice(index + 1)]
}

/**
 * Bots using familiar flat spellings get canonical Incur results and next actions.
 * Explicit legacy JSON/quiet/backend contracts and internal protocols stay intact.
 * @category parsing
 * @since 1.0.0
 */
export const agentArguments = (args: ReadonlyArray<string>): Array<string> | undefined => {
  if (
    args.some((arg) =>
      ["--json", "--quiet", "--help", "-h", "--version", "--backend"].includes(arg) ||
      arg.startsWith("--backend=")
    )
  ) return undefined
  let index = 0
  while (index < args.length && args[index]!.startsWith("-")) {
    const flag = args[index]!
    if (switches.has(flag) || [...valued].some((value) => flag.startsWith(`${value}=`))) index++
    else if (valued.has(flag)) index += 2
    else return undefined
  }
  const command = args[index]
  const aliases: Record<string, ReadonlyArray<string>> = {
    up: ["flow", "start"],
    plan: ["flow", "plan"],
    ls: ["flow", "list"],
    ps: ["runs", "list"],
    resume: ["runs", "resume"],
    cancel: ["runs", "cancel"],
    signal: ["runs", "signal"],
    steer: ["runs", "steer"],
    approve: ["approvals", "approve"],
    deny: ["approvals", "deny"],
    output: ["runs", "output"],
    down: ["runs", "cancel-all"]
  }
  if (command === undefined || aliases[command] === undefined) return undefined
  // A missing positional still uses the legacy parser's typed, file-free usage error.
  if (
    command !== "ls" && command !== "ps" && command !== "down" &&
    (args[index + 1] === undefined || args[index + 1]!.startsWith("--"))
  ) return undefined
  // Removed 0.x options must keep their specific migration refusal, not become
  // a generic Incur unknown-flag error through a superficially similar alias.
  const allowed = new Set([
    ...valued,
    ...switches,
    "--data",
    "--detached",
    "-d",
    "--scope",
    "--flow",
    "--status",
    "--message"
  ])
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg.split("=")[0]!))) return undefined
  return [...aliases[command], ...args.slice(0, index), ...args.slice(index + 1)]
}
