/*
 * Harness detection (LOCAL-APP.md, "Harness detection"): which agent CLIs
 * are installed and which account each is signed into. A dependency-free
 * port of the DETECTORS table in smithers/apps/cli/src/agent-detection.js
 * and the identity readers in agent-commands/accountIdentity.js.
 *
 * Binaries are probed at explicit candidate dirs before PATH, because a
 * Finder launch gets the launchd PATH. Every host read is injectable
 * (`HarnessHost`) so the table can be asserted without a machine's installs.
 * Version probes run in parallel under one timeout so the route never waits
 * on a slow CLI.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, delimiter, join, resolve } from "node:path"
import { HARNESS_IDS } from "smithers-shared/LocalApp"
import type { Harness } from "smithers-shared/LocalApp"
import { currentSandboxHost, probePolicy, wrapSandbox } from "./Sandbox"

export type HarnessId = (typeof HARNESS_IDS)[number]

export interface HarnessHost {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly platform: string
  /** Entries of a directory, or [] when it does not exist. */
  readonly listDir: (dir: string) => ReadonlyArray<string>
  /** True for an existing regular file (a symlink to one counts). */
  readonly isFile: (path: string) => boolean
  /** File text, or null when it cannot be read. */
  readonly readText: (path: string) => string | null
  /** `<binary> --version`, or null when it fails or exceeds the timeout. */
  readonly version: (binary: string) => Promise<string | null>
}

/** How long one `--version` may take before it is reported as null. */
export const VERSION_TIMEOUT_MS = 3000

/**
 * The explicit candidate dirs, in order, before PATH. `~/.opencode/bin` is
 * where the opencode installer puts its binary; the rest follow the contract.
 */
export const harnessCandidateDirs = (host: Pick<HarnessHost, "home" | "listDir">): ReadonlyArray<string> => {
  const nvmRoot = join(host.home, ".nvm", "versions", "node")
  const nvm = [...host.listDir(nvmRoot)]
    .filter((entry) => /^v?\d+\.\d+\.\d+/.test(entry))
    .sort((left, right) => compareSemver(right, left))
    .map((entry) => join(nvmRoot, entry, "bin"))
  return [
    join(host.home, ".local", "bin"),
    join(host.home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...nvm,
    join(host.home, ".cargo", "bin"),
    join(host.home, ".opencode", "bin")
  ]
}

const compareSemver = (left: string, right: string): number => {
  const parse = (value: string): [number, number, number] => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value)
    return match === null ? [0, 0, 0] : [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return 0
}

/** The first candidate dir, then PATH entry, that holds the binary. */
export const findBinary = (name: string, host: HarnessHost): string | null => {
  const fromPath = (host.env.PATH ?? "").split(delimiter).filter((dir) => dir !== "")
  for (const dir of [...harnessCandidateDirs(host), ...fromPath]) {
    const candidate = join(dir, name)
    if (host.isFile(candidate)) return candidate
  }
  return null
}

const readJson = (host: HarnessHost, path: string): Record<string, unknown> | null => {
  const text = host.readText(path)
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const readJsonAny = (host: HarnessHost, path: string): unknown => {
  const text = host.readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

/** True when the JSON value holds at least one non-empty string anywhere below. */
const hasNonEmptyStringDeep = (value: unknown, depth = 0): boolean => {
  if (depth > 8) return false
  if (nonEmptyString(value)) return true
  if (Array.isArray(value)) return value.some((entry) => hasNonEmptyStringDeep(entry, depth + 1))
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((entry) => hasNonEmptyStringDeep(entry, depth + 1))
  }
  return false
}

/**
 * A JWT's payload, decoded without verification: the vendor CLI wrote the
 * token into a file only this user can read, and the claims only label the
 * account for the human. Never returns the token itself.
 */
export const decodeJwtClaims = (token: unknown): Record<string, unknown> | null => {
  if (typeof token !== "string") return null
  const payload = token.split(".")[1]
  if (payload === undefined || payload === "") return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const firstEnv = (env: HarnessHost["env"], names: ReadonlyArray<string>): string | undefined =>
  names.find((name) => nonEmptyString(env[name]))

const envDir = (host: HarnessHost, name: string, fallback: string): string => {
  const value = host.env[name]
  return nonEmptyString(value) ? resolve(value) : fallback
}

/** Sign-in state and account, before the binary is considered. */
interface Signal {
  readonly status: Exclude<Harness["status"], "unavailable">
  readonly account: Harness["account"]
}

const binaryOnly: Signal = { status: "binary-only", account: null }

const apiKey = (name: string): Signal => ({ status: "api-key", account: { label: name } })

/** `~/x` for a path below home, so a label stays short. */
const tilde = (host: HarnessHost, path: string): string => (path.startsWith(`${host.home}/`) ? `~${path.slice(host.home.length)}` : path)

interface Detector {
  readonly id: HarnessId
  readonly displayName: string
  readonly binary: string
  readonly launch: ReadonlyArray<string>
  readonly signal: (host: HarnessHost) => Signal
}

export const DETECTORS: ReadonlyArray<Detector> = [
  {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    launch: ["claude"],
    signal: (host) => {
      const state = readJson(host, join(host.home, ".claude.json"))
      const oauth = state?.oauthAccount
      const configDir = envDir(host, "CLAUDE_CONFIG_DIR", join(host.home, ".claude"))
      if (typeof oauth === "object" && oauth !== null) {
        const { emailAddress, organizationName } = oauth as Record<string, unknown>
        return {
          status: "signed-in",
          account: {
            ...(nonEmptyString(emailAddress) ? { email: emailAddress } : {}),
            ...(nonEmptyString(organizationName) ? { label: organizationName } : {})
          }
        }
      }
      if (host.isFile(join(configDir, ".credentials.json"))) return { status: "signed-in", account: null }
      const key = firstEnv(host.env, ["ANTHROPIC_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "codex",
    displayName: "Codex",
    binary: "codex",
    launch: ["codex"],
    signal: (host) => {
      const auth = readJson(host, join(envDir(host, "CODEX_HOME", join(host.home, ".codex")), "auth.json"))
      const tokens = auth?.tokens
      if (typeof tokens === "object" && tokens !== null) {
        const { id_token, access_token } = tokens as Record<string, unknown>
        const claims = decodeJwtClaims(id_token)
        const email = claims?.email
        if (nonEmptyString(email)) return { status: "signed-in", account: { email } }
        if (nonEmptyString(id_token) || nonEmptyString(access_token)) return { status: "signed-in", account: null }
      }
      if (nonEmptyString(auth?.OPENAI_API_KEY)) return { status: "api-key", account: { label: "auth.json OPENAI_API_KEY" } }
      const key = firstEnv(host.env, ["OPENAI_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "gemini",
    displayName: "Gemini",
    binary: "gemini",
    launch: ["gemini"],
    signal: (host) => {
      const root = envDir(host, "GEMINI_DIR", join(host.home, ".gemini"))
      if (host.isFile(join(root, "oauth_creds.json"))) {
        const accounts = readJson(host, join(root, "google_accounts.json"))
        const active = accounts?.active
        return { status: "signed-in", account: nonEmptyString(active) ? { email: active } : null }
      }
      const key = firstEnv(host.env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "kimi",
    displayName: "Kimi",
    binary: "kimi",
    launch: ["kimi"],
    signal: (host) => {
      const share = envDir(host, "KIMI_SHARE_DIR", join(host.home, ".kimi"))
      if (host.isFile(join(share, "credentials", "kimi-code.json"))) {
        return { status: "signed-in", account: { label: "kimi-code" } }
      }
      return binaryOnly
    }
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    launch: ["opencode"],
    signal: (host) => {
      const auth = readJson(host, join(host.home, ".local", "share", "opencode", "auth.json"))
      const providers = auth === null ? [] : Object.keys(auth).filter((id) => hasNonEmptyStringDeep(auth[id]))
      if (providers.length > 0) return { status: "signed-in", account: { label: providers.join(", ") } }
      const key = firstEnv(host.env, ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "crush",
    displayName: "Crush",
    binary: "crush",
    launch: ["crush"],
    signal: (host) => {
      const key = firstEnv(host.env, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"])
      if (key !== undefined) return apiKey(key)
      const configs = [
        join(host.home, ".local", "share", "crush", "providers.json"),
        join(host.home, ".config", "crush", "crush.json")
      ]
      const found = configs.find((path) => hasNonEmptyStringDeep(readJsonAny(host, path)))
      return found === undefined ? binaryOnly : { status: "signed-in", account: { label: tilde(host, found) } }
    }
  },
  {
    id: "amp",
    displayName: "Amp",
    binary: "amp",
    launch: ["amp"],
    signal: (host) => {
      const key = firstEnv(host.env, ["AMP_API_KEY"])
      if (key !== undefined) return apiKey(key)
      const secrets = join(host.home, ".config", "amp", "secrets.json")
      return hasNonEmptyStringDeep(readJsonAny(host, secrets))
        ? { status: "signed-in", account: { label: tilde(host, secrets) } }
        : binaryOnly
    }
  },
  {
    id: "cursor-agent",
    displayName: "Cursor Agent",
    binary: "cursor-agent",
    launch: ["cursor-agent"],
    signal: (host) => {
      const key = firstEnv(host.env, ["CURSOR_API_KEY"])
      if (key !== undefined) return apiKey(key)
      const auth = host.platform === "darwin"
        ? join(host.home, ".cursor", "auth.json")
        : join(envDir(host, "XDG_CONFIG_HOME", join(host.home, ".config")), "cursor", "auth.json")
      return hasNonEmptyStringDeep(readJsonAny(host, auth))
        ? { status: "signed-in", account: { label: tilde(host, auth) } }
        : binaryOnly
    }
  },
  {
    id: "hermes",
    displayName: "Hermes",
    binary: "hermes",
    launch: ["hermes"],
    signal: (host) => {
      const auth = join(host.home, ".hermes", "auth.json")
      if (hasNonEmptyStringDeep(readJsonAny(host, auth))) return { status: "signed-in", account: { label: tilde(host, auth) } }
      const config = join(host.home, ".hermes", "config.yaml")
      return host.isFile(config) ? { status: "signed-in", account: { label: tilde(host, config) } } : binaryOnly
    }
  },
  {
    id: "pi",
    displayName: "Pi",
    binary: "pi",
    launch: ["pi"],
    signal: (host) => {
      const auth = join(host.home, ".pi", "agent", "auth.json")
      return hasNonEmptyStringDeep(readJsonAny(host, auth))
        ? { status: "signed-in", account: { label: tilde(host, auth) } }
        : binaryOnly
    }
  }
]

/** "2.1.247 (Claude Code)" -> "2.1.247"; "crush version v0.1.11" -> "0.1.11"; else the first line. */
export const parseVersionLine = (output: string): string | null => {
  const firstLine = output.split("\n").map((line) => line.trim()).find((line) => line !== "")
  if (firstLine === undefined) return null
  const match = /\d+\.\d+(?:\.\d+)?[0-9A-Za-z.+-]*/.exec(firstLine)
  return match === null ? firstLine : match[0]
}

/** The harness table for one host: every id, in contract order, whether installed or not. */
export const detectHarnessesWith = async (host: HarnessHost): Promise<Array<Harness>> => {
  const found = DETECTORS.map((detector) => ({ detector, binary: findBinary(detector.binary, host) }))
  const versions = await Promise.all(found.map(({ binary }) => (binary === null ? Promise.resolve(null) : host.version(binary))))
  return found.map(({ detector, binary }, index) => {
    const signal = binary === null ? null : detector.signal(host)
    return {
      id: detector.id,
      displayName: detector.displayName,
      binary,
      version: versions[index] ?? null,
      status: signal === null ? "unavailable" : signal.status,
      account: signal === null ? null : signal.account,
      launch: { argv: [...detector.launch] }
    }
  })
}

/** Versions change with a reinstall, not between two menu opens: one probe per binary path per process. */
const versionCache = new Map<string, Promise<string | null>>()

/**
 * Binaries whose `--version` fails under the probe seatbelt profile and runs
 * unwrapped instead (LOCAL-APP.md, "Sandbox", documented exceptions).
 * amp: writes under `~/.cache` (beyond `~/.cache/amp`) on every invocation
 * and aborts when `(deny file-write*)` blocks it.
 */
const PROBE_SANDBOX_EXCEPTIONS: ReadonlySet<string> = new Set(["amp"])

/** Seatbelt matches resolved paths, so the scratch dir the probe may write is canonicalised. */
const probeTmpdir = (): string => {
  try {
    return realpathSync(tmpdir())
  } catch {
    return tmpdir()
  }
}

const runVersion = (binary: string): Promise<string | null> => {
  const cached = versionCache.get(binary)
  if (cached !== undefined) return cached
  const probe = (async (): Promise<string | null> => {
    try {
      // Read-only probe: no network, writes confined to scratch (LOCAL-APP.md, "Sandbox").
      const wrapped = PROBE_SANDBOX_EXCEPTIONS.has(basename(binary))
        ? { argv: [binary, "--version"] as ReadonlyArray<string> }
        : wrapSandbox([binary, "--version"], probePolicy({ tmpdir: probeTmpdir() }), currentSandboxHost())
      const child = Bun.spawn([...wrapped.argv], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        timeout: VERSION_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: { ...process.env, NO_COLOR: "1" }
      })
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
      return code === 0 ? parseVersionLine(stdout) : null
    } catch {
      return null
    }
  })()
  versionCache.set(binary, probe)
  // A failed or timed-out probe is retried on the next call.
  void probe.then((version) => {
    if (version === null) versionCache.delete(binary)
  })
  return probe
}

export const currentHarnessHost = (env: Readonly<Record<string, string | undefined>> = Bun.env): HarnessHost => ({
  env,
  home: env.HOME ?? homedir(),
  platform: process.platform,
  listDir: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  },
  version: runVersion
})

export const detectHarnesses = (env?: Readonly<Record<string, string | undefined>>): Promise<Array<Harness>> =>
  detectHarnessesWith(currentHarnessHost(env))
