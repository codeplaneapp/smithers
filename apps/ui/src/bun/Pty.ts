/*
 * PTY sessions (LOCAL-APP.md, "HTTP and WebSocket API", the `/api/pty*`
 * routes and the `pty:<sessionId>` topics). A session is one
 * `Bun.spawn({ terminal })` child: the login shell for a terminal tab, the
 * harness's interactive command for a harness tab. Both run under the
 * sandbox policy of their kind (Sandbox.ts), in the expanded cwd, with an
 * allowlisted environment.
 *
 * Output goes out as UTF-8 text frames on the session's topic; input comes
 * back through `write`. Exited sessions stay listed (`alive: false`) until
 * the SPA deletes them, so a tab can still show the exit line and close
 * without a second kill.
 */
import { randomBytes } from "node:crypto"
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, resolve } from "node:path"
import type { Harness, PtySession } from "smithers-shared/LocalApp"
import { harnessCandidateDirs } from "./Harnesses"
import { currentSandboxHost, harnessPolicy, terminalPolicy, wrapSandbox } from "./Sandbox"
import type { SandboxHost } from "./Sandbox"

export interface PtyCreateInput {
  readonly kind: PtySession["kind"]
  /** "~" or "~/x" expands against the server's home. */
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly harnessId?: Harness["id"]
}

export type PtyCreateResult =
  | { readonly status: "ok"; readonly session: PtySession }
  | { readonly status: "error"; readonly code: "bad_cwd" | "unknown_harness" | "harness_unavailable" | "capacity_reached" | "spawn_failed"; readonly message: string }

export interface PtyManager {
  readonly create: (input: PtyCreateInput) => Promise<PtyCreateResult>
  readonly list: () => Array<PtySession>
  readonly get: (sessionId: string) => PtySession | undefined
  /** Text typed by the user; false when the session is unknown or gone. */
  readonly write: (sessionId: string, data: string) => boolean
  readonly resize: (sessionId: string, cols: number, rows: number) => boolean
  /** SIGHUP, then SIGKILL after a grace period; the record is dropped. False when unknown. */
  readonly kill: (sessionId: string) => Promise<boolean>
  readonly killAll: () => Promise<void>
}

export interface PtyManagerOptions {
  /** `pty:<sessionId>` frames go out through here (the server's publish). */
  readonly publish: (topic: string, message: unknown) => void
  /** The harness table, read when a harness tab opens (its binary and launch argv). */
  readonly harnesses: () => Promise<ReadonlyArray<Harness>>
  readonly home?: string
  readonly tmpdir?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The login shell for terminal tabs; default `$SHELL`, then /bin/zsh. */
  readonly shell?: string
  /** Extra PATH entries the children inherit ahead of the app's own PATH (the Node sidecar's dir). */
  readonly pathPrepend?: ReadonlyArray<string> | (() => Promise<ReadonlyArray<string>>)
  readonly sandboxHost?: SandboxHost
  /** Grace between SIGHUP and SIGKILL on kill. */
  readonly killGraceMs?: number
  /** Maximum simultaneously live child processes; default 8. */
  readonly maxSessions?: number
  readonly log?: (line: string) => void
}

/** What a child inherits from the app's environment, and nothing else. */
export const ENV_ALLOWLIST: ReadonlyArray<string> = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GEMINI_DIR",
  "KIMI_SHARE_DIR",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "CURSOR_API_KEY",
  "AMP_API_KEY"
]

/** `~` and `~/x` against the home directory; anything else resolved as-is. */
export const expandCwd = (cwd: string, home: string): string => {
  const trimmed = cwd.trim()
  if (trimmed === "" || trimmed === "~") return home
  if (trimmed.startsWith("~/")) return resolve(home, trimmed.slice(2))
  return resolve(trimmed)
}

/**
 * The child's environment: the allowlist, TERM/COLORTERM/LANG for an
 * xterm-256color emulator, and a PATH that starts with the harness
 * candidate dirs (a Finder launch has the launchd PATH, which lacks
 * `~/.local/bin` and homebrew) and the Node sidecar so a `#!/usr/bin/env node`
 * CLI like codex resolves.
 */
export const childEnv = (
  source: Readonly<Record<string, string | undefined>>,
  home: string,
  pathPrepend: ReadonlyArray<string>
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of ENV_ALLOWLIST) {
    const value = source[name]
    if (value !== undefined && value !== "") env[name] = value
  }
  env.HOME = home
  env.TERM = "xterm-256color"
  env.COLORTERM = "truecolor"
  env.LANG = env.LANG ?? "en_US.UTF-8"
  const listDir = (dir: string): ReadonlyArray<string> => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  const path = [
    ...pathPrepend,
    ...harnessCandidateDirs({ home, listDir }).filter((dir) => existsSync(dir)),
    ...(source.PATH ?? "").split(delimiter),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].filter((dir) => dir !== "")
  env.PATH = [...new Set(path)].join(delimiter)
  return env
}

const newSessionId = (): string => `pty-${randomBytes(16).toString("hex")}`

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

interface LiveSession {
  readonly record: PtySession
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly decoder: TextDecoder
  exited: Promise<void>
}

export const createPtyManager = (options: PtyManagerOptions): PtyManager => {
  const log = options.log ?? ((line: string) => console.error(line))
  const home = options.home ?? homedir()
  const scratch = options.tmpdir ?? safeRealpath(tmpdir())
  const env = options.env ?? Bun.env
  const shell = options.shell ?? (env.SHELL !== undefined && env.SHELL !== "" ? env.SHELL : "/bin/zsh")
  const sandboxHost = options.sandboxHost ?? currentSandboxHost(env)
  const killGraceMs = options.killGraceMs ?? 2000
  const maxSessions = options.maxSessions ?? 8
  const sessions = new Map<string, LiveSession>()

  const topic = (sessionId: string): string => `pty:${sessionId}`

  const create: PtyManager["create"] = async (input) => {
    const liveCount = [...sessions.values()].filter((session) => session.record.alive).length
    if (liveCount >= maxSessions) {
      return { status: "error", code: "capacity_reached", message: `At most ${maxSessions} terminal sessions may run at once.` }
    }
    const cwd = expandCwd(input.cwd, home)
    if (!isDirectory(cwd)) return { status: "error", code: "bad_cwd", message: `${cwd} is not a directory.` }
    let argv: Array<string>
    let harnessId: Harness["id"] | undefined
    if (input.kind === "harness") {
      const harness = (await options.harnesses()).find((candidate) => candidate.id === input.harnessId)
      if (harness === undefined) {
        return { status: "error", code: "unknown_harness", message: `There is no harness with id ${String(input.harnessId)}.` }
      }
      if (harness.status === "unavailable" || harness.binary === null) {
        return { status: "error", code: "harness_unavailable", message: `${harness.displayName} is not installed here.` }
      }
      harnessId = harness.id
      // The resolved binary, so a Finder launch's PATH cannot lose it.
      argv = [harness.binary, ...harness.launch.argv.slice(1)]
    } else {
      argv = [shell, "-il"]
    }
    const paths = { repo: cwd, home, tmpdir: scratch }
    const wrapped = wrapSandbox(argv, input.kind === "harness" ? harnessPolicy(paths) : terminalPolicy(paths), sandboxHost)
    const sessionId = newSessionId()
    const prepend = typeof options.pathPrepend === "function" ? await options.pathPrepend() : options.pathPrepend ?? []
    const childEnvironment = childEnv(env, home, prepend)
    const decoder = new TextDecoder("utf-8")
    let eof: () => void = () => {}
    const eofSeen = new Promise<void>((resolveEof) => {
      eof = resolveEof
    })
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn([...wrapped.argv], {
        cwd,
        env: childEnvironment,
        terminal: {
          cols: Math.max(2, Math.floor(input.cols)),
          rows: Math.max(1, Math.floor(input.rows)),
          name: "xterm-256color",
          data: (_terminal, chunk) => {
            const text = decoder.decode(chunk, { stream: true })
            if (text !== "") options.publish(topic(sessionId), { type: "pty.output", sessionId, data: text })
          },
          exit: () => eof()
        }
      })
    } catch (error) {
      return { status: "error", code: "spawn_failed", message: error instanceof Error ? error.message : String(error) }
    }
    const record: PtySession = {
      sessionId,
      kind: input.kind,
      ...(harnessId === undefined ? {} : { harnessId }),
      cwd,
      pid: proc.pid,
      alive: true
    }
    const live: LiveSession = { record, proc, decoder, exited: Promise.resolve() }
    sessions.set(sessionId, live)
    log(`pty ${sessionId}: ${input.kind} pid ${proc.pid} in ${cwd} (sandbox ${wrapped.enforced ? "on" : "off"})`)
    live.exited = proc.exited.then(async (code) => {
      // The last output usually lands after SIGCHLD; the PTY's EOF (or a short grace) orders it before the exit frame.
      await Promise.race([eofSeen, Bun.sleep(300)])
      const tail = decoder.decode()
      if (tail !== "") options.publish(topic(sessionId), { type: "pty.output", sessionId, data: tail })
      const current = sessions.get(sessionId)
      if (current !== undefined) sessions.set(sessionId, { ...current, record: { ...current.record, alive: false } })
      options.publish(topic(sessionId), { type: "pty.exit", sessionId, code: typeof code === "number" ? code : null })
      log(`pty ${sessionId}: exited ${String(code)}`)
      try {
        proc.terminal?.close()
      } catch {
        // Already closed.
      }
    })
    return { status: "ok", session: record }
  }

  const list: PtyManager["list"] = () => [...sessions.values()].map((live) => ({ ...live.record }))

  const get: PtyManager["get"] = (sessionId) => {
    const live = sessions.get(sessionId)
    return live === undefined ? undefined : { ...live.record }
  }

  const write: PtyManager["write"] = (sessionId, data) => {
    const live = sessions.get(sessionId)
    if (live === undefined || !live.record.alive || live.proc.terminal === undefined) return false
    try {
      live.proc.terminal.write(data)
      return true
    } catch {
      return false
    }
  }

  const resize: PtyManager["resize"] = (sessionId, cols, rows) => {
    const live = sessions.get(sessionId)
    if (live === undefined || !live.record.alive || live.proc.terminal === undefined) return false
    try {
      live.proc.terminal.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)))
      return true
    } catch {
      return false
    }
  }

  const kill: PtyManager["kill"] = async (sessionId) => {
    const live = sessions.get(sessionId)
    if (live === undefined) return false
    sessions.delete(sessionId)
    if (live.record.alive) {
      try {
        live.proc.kill("SIGHUP")
      } catch {
        // Already gone.
      }
      const exited = await Promise.race([live.exited.then(() => true), Bun.sleep(killGraceMs).then(() => false)])
      if (!exited) {
        try {
          live.proc.kill("SIGKILL")
        } catch {
          // Already gone.
        }
        await Promise.race([live.exited, Bun.sleep(1000)])
      }
    }
    try {
      live.proc.terminal?.close()
    } catch {
      // Already closed.
    }
    return true
  }

  const killAll: PtyManager["killAll"] = async () => {
    await Promise.all([...sessions.keys()].map((sessionId) => kill(sessionId)))
  }

  return { create, list, get, write, resize, kill, killAll }
}

const safeRealpath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The directory of a Node sidecar, for `pathPrepend`. */
export const binDirOf = (path: string | null | undefined): ReadonlyArray<string> =>
  path === null || path === undefined || path === "" ? [] : [dirname(path)]
