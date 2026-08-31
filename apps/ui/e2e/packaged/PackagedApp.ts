import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const DEFAULT_STARTUP_TIMEOUT_MS = 90_000
const REQUEST_TIMEOUT_MS = 5_000
const EXIT_TIMEOUT_MS = 8_000
const MAX_LOG_CHARACTERS = 512_000

export interface LaunchAppOptions {
  readonly executable: string
  readonly stateDirectory?: string
  readonly artifactsDirectory?: string
  readonly env?: Readonly<Record<string, string>>
  readonly startupTimeoutMs?: number
}

export interface PackagedAppState {
  readonly app: {
    readonly pid: number
    readonly origin: string
    readonly packaged: boolean
    readonly channel: string
    readonly defaultRenderer: string
  }
  readonly window: null | {
    readonly id: number
    readonly webviewId: number
    readonly renderer: string
    readonly url: string | null
    readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  }
}

interface BridgeEvalResponse<T> {
  readonly result: T | null
  readonly valueUndefined?: boolean
}

interface ProcessExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const safeLabel = (label: string): string =>
  label.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "diagnostic"

const availableLoopbackPort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) {
        server.close()
        reject(new Error("The operating system did not allocate a loopback port."))
        return
      }
      server.close((error) => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })

const responseText = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => "")
  return text === "" ? response.statusText : text
}

const normalizeEvalScript = (script: string): string => {
  const trimmed = script.trim()
  if (trimmed === "") return "return undefined"
  try {
    // Syntax-check locally only. Expression-shaped input gets its completion
    // value; statement-shaped input can use an explicit return.
    new Function(`return (\n${trimmed}\n)`)
    return `return (\n${trimmed}\n)`
  } catch {
    return trimmed
  }
}

const processExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

export class PackagedApp {
  readonly executable: string
  readonly artifactsDirectory: string
  readonly stateDirectory: string

  private readonly temporaryRoot: string
  private readonly processEnv: Readonly<Record<string, string>>
  private readonly startupTimeoutMs: number
  private readonly localPort: number
  private child: ChildProcess | undefined
  private exit: Promise<ProcessExit> | undefined
  private bridgePort: number | undefined
  private bridgeToken: string | undefined
  private readyPromise: Promise<void> | undefined
  private logBuffer = ""
  private launchNumber = 0
  private cleaned = false

  private constructor(
    options: LaunchAppOptions,
    temporaryRoot: string,
    stateDirectory: string,
    artifactsDirectory: string,
    localPort: number
  ) {
    this.executable = resolve(options.executable)
    this.temporaryRoot = temporaryRoot
    this.stateDirectory = stateDirectory
    this.artifactsDirectory = artifactsDirectory
    this.processEnv = options.env ?? {}
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.localPort = localPort
  }

  static async launch(options: LaunchAppOptions): Promise<PackagedApp> {
    const executable = resolve(options.executable)
    await access(executable, constants.X_OK).catch(() => {
      throw new Error(`Packaged Electrobun executable is missing or not executable: ${executable}`)
    })

    const temporaryRoot = await mkdtemp(join(tmpdir(), "smithers-electrobun-e2e-"))
    const stateDirectory = resolve(options.stateDirectory ?? join(temporaryRoot, "home"))
    const artifactsDirectory = resolve(
      options.artifactsDirectory ?? join(process.cwd(), "test-results", "electrobun-packaged")
    )
    await Promise.all([
      mkdir(stateDirectory, { recursive: true }),
      mkdir(join(temporaryRoot, "tmp"), { recursive: true }),
      mkdir(join(stateDirectory, ".cache"), { recursive: true }),
      mkdir(join(stateDirectory, ".config"), { recursive: true }),
      mkdir(join(stateDirectory, ".local", "share"), { recursive: true }),
      mkdir(artifactsDirectory, { recursive: true })
    ])

    const app = new PackagedApp(
      { ...options, executable },
      temporaryRoot,
      stateDirectory,
      artifactsDirectory,
      await availableLoopbackPort()
    )
    await app.startProcess()
    return app
  }

  get bridgeOrigin(): string {
    if (this.bridgePort === undefined) throw new Error("The E2E bridge has not started.")
    return `http://127.0.0.1:${this.bridgePort}`
  }

  logs(): string {
    return this.logBuffer
  }

  private appendLog(stream: "runner" | "stdout" | "stderr", text: string): void {
    const prefixed = text.split(/(?<=\n)/).map((line) => line === "" ? "" : `[${stream}] ${line}`).join("")
    this.logBuffer += prefixed
    if (this.logBuffer.length > MAX_LOG_CHARACTERS) this.logBuffer = this.logBuffer.slice(-MAX_LOG_CHARACTERS)
    if (process.env.SMITHERS_E2E_VERBOSE === "1") process.stderr.write(prefixed)
  }

  private async startProcess(): Promise<void> {
    if (this.cleaned) throw new Error("A cleaned-up packaged app cannot be relaunched.")
    if (this.child !== undefined && !processExited(this.child)) throw new Error("The packaged app is already running.")

    this.launchNumber += 1
    this.bridgePort = await availableLoopbackPort()
    this.bridgeToken = randomBytes(32).toString("base64url")
    this.readyPromise = undefined
    this.appendLog("runner", `launch ${this.launchNumber}: ${this.executable}\n`)

    const tmpDirectory = join(this.temporaryRoot, "tmp")
    const protectedEnv: NodeJS.ProcessEnv = {
      HOME: this.stateDirectory,
      CFFIXED_USER_HOME: this.stateDirectory,
      TMPDIR: tmpDirectory,
      XDG_CACHE_HOME: join(this.stateDirectory, ".cache"),
      XDG_CONFIG_HOME: join(this.stateDirectory, ".config"),
      XDG_DATA_HOME: join(this.stateDirectory, ".local", "share"),
      SMITHERS_E2E_BRIDGE: "1",
      SMITHERS_E2E_BRIDGE_PORT: String(this.bridgePort),
      SMITHERS_E2E_BRIDGE_TOKEN: this.bridgeToken,
      SMITHERS_LOCAL_PORT: String(this.localPort),
      SMITHERS_LOCAL_MODE: "offline",
      SMITHERS_CHAT_STUB: "1",
      ELECTROBUN_CONSOLE: "1",
      NO_COLOR: "1"
    }
    const child = spawn(this.executable, [], {
      cwd: dirname(this.executable),
      detached: process.platform !== "win32",
      env: { ...process.env, ...this.processEnv, ...protectedEnv },
      stdio: ["ignore", "pipe", "pipe"]
    })
    this.child = child
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.appendLog("stdout", chunk))
    child.stderr?.on("data", (chunk: string) => this.appendLog("stderr", chunk))
    child.once("error", (error) => this.appendLog("runner", `spawn error: ${error.message}\n`))
    this.exit = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        this.appendLog("runner", `exit: code=${String(code)} signal=${String(signal)}\n`)
        resolveExit({ code, signal })
      })
    })
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    if (this.bridgeToken === undefined) throw new Error("The E2E bridge token is unavailable.")
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(`${this.bridgeOrigin}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.bridgeToken}`,
          ...init.headers
        },
        signal: controller.signal
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init)
    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${await responseText(response)}`)
    }
    return response.json() as Promise<T>
  }

  async ready(): Promise<void> {
    if (this.readyPromise !== undefined) return this.readyPromise
    this.readyPromise = this.waitUntilReady()
    return this.readyPromise
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      if (this.child === undefined || processExited(this.child)) {
        const exited = this.exit === undefined ? undefined : await this.exit
        throw new Error(`Packaged app exited during startup (${JSON.stringify(exited)}).\n${this.logs()}`)
      }
      try {
        const health = await this.json<{ readonly ok?: boolean }>("/health")
        if (health.ok !== true) throw new Error("The E2E bridge reported unhealthy.")
        const state = await this.state()
        if (state.window === null) throw new Error("The main window has not been created.")
        const documentState = await this.eval<{ readonly readyState: string; readonly bodyPresent: boolean }>(`
          ({ readyState: document.readyState, bodyPresent: document.body !== null })
        `)
        if (documentState.bodyPresent && documentState.readyState !== "loading") return
      } catch (error) {
        lastError = error
      }
      await delay(200)
    }
    throw new Error(
      `Packaged app did not become ready within ${this.startupTimeoutMs}ms: ${String(lastError)}\n${this.logs()}`
    )
  }

  async state(): Promise<PackagedAppState> {
    return this.json<PackagedAppState>("/state")
  }

  async eval<T = unknown>(script: string): Promise<T> {
    const response = await this.json<BridgeEvalResponse<T>>("/window/eval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: normalizeEvalScript(script) })
    })
    return (response.valueUndefined === true ? undefined : response.result) as T
  }

  async waitFor<T>(
    script: string,
    predicate: (value: T) => boolean = (value) => Boolean(value),
    timeoutMs = 15_000
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let lastValue: T | undefined
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        lastValue = await this.eval<T>(script)
        if (predicate(lastValue)) return lastValue
      } catch (error) {
        lastError = error
      }
      await delay(100)
    }
    throw new Error(
      `Renderer condition did not pass within ${timeoutMs}ms. Last value: ${JSON.stringify(lastValue)}. Last error: ${
        String(lastError)
      }`
    )
  }

  async unauthorizedStatus(path = "/health"): Promise<number> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return (await fetch(`${this.bridgeOrigin}${path}`, { signal: controller.signal })).status
    } finally {
      clearTimeout(timeout)
    }
  }

  async screenshot(name = `launch-${this.launchNumber}.png`): Promise<string> {
    const response = await this.request("/window/screenshot")
    if (!response.ok) {
      throw new Error(`GET /window/screenshot returned ${response.status}: ${await responseText(response)}`)
    }
    const path = join(this.artifactsDirectory, safeLabel(name.endsWith(".png") ? name : `${name}.png`))
    await writeFile(path, new Uint8Array(await response.arrayBuffer()))
    return path
  }

  async captureDiagnostics(label: string): Promise<void> {
    const stem = safeLabel(label)
    await mkdir(this.artifactsDirectory, { recursive: true })
    await writeFile(join(this.artifactsDirectory, `${stem}.log`), this.logs())
    await this.state()
      .then((value) =>
        writeFile(join(this.artifactsDirectory, `${stem}-state.json`), `${JSON.stringify(value, null, 2)}\n`)
      )
      .catch(() => undefined)
    await this.screenshot(`${stem}.png`).catch(() => undefined)
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child === undefined || processExited(this.child)) return true
    if (this.exit === undefined) return false
    return Promise.race([
      this.exit.then(() => true),
      delay(timeoutMs).then(() => false)
    ])
  }

  private signalProcess(signal: NodeJS.Signals): void {
    const child = this.child
    if (child === undefined || processExited(child) || child.pid === undefined) return
    try {
      if (process.platform === "win32") child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // It exited between the checks.
      }
    }
  }

  async quit(): Promise<void> {
    if (this.child === undefined || processExited(this.child)) return
    await this.request("/app/quit", { method: "POST" }).catch(() => undefined)
    if (await this.waitForExit(EXIT_TIMEOUT_MS)) return
    this.signalProcess("SIGTERM")
    if (await this.waitForExit(EXIT_TIMEOUT_MS)) return
    this.signalProcess("SIGKILL")
    if (!await this.waitForExit(EXIT_TIMEOUT_MS)) {
      throw new Error(`Packaged app process group did not terminate.\n${this.logs()}`)
    }
  }

  async relaunch(): Promise<void> {
    await this.quit()
    await this.startProcess()
    await this.ready()
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return
    await this.quit()
    this.cleaned = true
    const expectedPrefix = join(tmpdir(), "smithers-electrobun-e2e-")
    if (!this.temporaryRoot.startsWith(expectedPrefix)) {
      throw new Error(`Refusing to remove unexpected temporary path: ${this.temporaryRoot}`)
    }
    await rm(this.temporaryRoot, { recursive: true, force: true })
  }
}

export const launchApp = (options: LaunchAppOptions): Promise<PackagedApp> => PackagedApp.launch(options)

interface ProductionCandidate {
  readonly executable: string
  readonly modifiedAt: number
}

/** Finds only stable, native-renderer macOS bundles produced by Electrobun. */
export const findProductionAppExecutable = async (uiDirectory: string): Promise<string> => {
  const buildDirectory = join(uiDirectory, "build")
  if (!existsSync(buildDirectory)) throw new Error(`${buildDirectory} does not exist; package the app first.`)
  const platforms = await readdir(buildDirectory, { withFileTypes: true })
  const candidates: Array<ProductionCandidate> = []

  for (const platform of platforms) {
    if (!platform.isDirectory() || !platform.name.startsWith("stable-macos-")) continue
    const platformDirectory = join(buildDirectory, platform.name)
    for (const entry of await readdir(platformDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue
      const bundle = join(platformDirectory, entry.name)
      const resources = join(bundle, "Contents", "Resources")
      const version = JSON.parse(await readFile(join(resources, "version.json"), "utf8")) as {
        readonly channel?: unknown
      }
      const build = JSON.parse(await readFile(join(resources, "build.json"), "utf8")) as {
        readonly defaultRenderer?: unknown
        readonly buildEnvironment?: unknown
      }
      if (version.channel !== "stable" || build.buildEnvironment !== "stable" || build.defaultRenderer !== "native") {
        continue
      }
      const executable = join(bundle, "Contents", "MacOS", "launcher")
      await access(executable, constants.X_OK)
      candidates.push({ executable, modifiedAt: (await stat(executable)).mtimeMs })
    }
  }

  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
  const candidate = candidates[0]
  if (candidate === undefined) {
    throw new Error(`No stable native-renderer Electrobun launcher found under ${buildDirectory}.`)
  }
  return candidate.executable
}
