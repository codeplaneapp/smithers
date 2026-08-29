/*
 * T2 launcher (`pnpm --filter smithers-ui test:e2e:native`): builds the SPA
 * and the Electrobun dev app (CEF bundled, LOCAL-APP.md), launches the built
 * .app binary directly with a fixed CDP port and local port, waits for the
 * origin line, runs the native Playwright project against it, then kills
 * the app. Every step prints what it did; a failure names the step.
 *
 *   SMITHERS_SKIP_NATIVE_BUILD=1   reuse build/ and dist/ as they are
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const UI_DIR = fileURLToPath(new URL("../../../", import.meta.url))
const CDP_PORT = 9333
const LOCAL_PORT = 47313
const LAUNCH_TIMEOUT_MS = 120_000

const fail = (message: string): never => {
  console.error(`FAIL: native e2e: ${message}`)
  process.exit(1)
}

const run = async (argv: ReadonlyArray<string>, env: Record<string, string> = {}): Promise<number> => {
  console.log(`[native] $ ${argv.join(" ")}`)
  const child = Bun.spawn([...argv], {
    cwd: UI_DIR,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit"
  })
  return child.exited
}

/** The executable inside the dev bundle Hutch produced. */
const findAppBinary = (): string => {
  const buildDir = join(UI_DIR, "build")
  if (!existsSync(buildDir)) fail("build/ is missing: the electrobun build did not run")
  const bundles = readdirSync(buildDir)
    .filter((entry) => entry.startsWith("dev-"))
    .flatMap((entry) => {
      const dir = join(buildDir, entry)
      return readdirSync(dir).filter((name) => name.endsWith(".app")).map((name) => join(dir, name))
    })
  const bundle = bundles[0]
  if (bundle === undefined) fail("no dev-*/*.app under build/")
  const macos = join(bundle as string, "Contents", "MacOS")
  const binaries = existsSync(macos) ? readdirSync(macos) : []
  const preferred = binaries.find((name) => name === "launcher" || name === "bun" || name === "Smithers-dev") ?? binaries[0]
  if (preferred === undefined) fail(`${macos} holds no executable`)
  return join(macos, preferred as string)
}

const main = async (): Promise<void> => {
  if (process.platform !== "darwin") {
    console.log("SKIP: the native tier builds and launches a macOS .app; nothing else can run it here.")
    process.exit(0)
  }
  if (process.env.SMITHERS_SKIP_NATIVE_BUILD !== "1") {
    if ((await run([process.execPath, "scripts/ensure-devkit.mjs"])) !== 0) fail("ensure-devkit failed")
    if ((await run(["pnpm", "exec", "vite", "build", "--configLoader", "runner"])) !== 0) fail("vite build failed")
    if ((await run(["pnpm", "exec", "electrobun", "build", "--env=dev"])) !== 0) fail("electrobun build --env=dev failed")
  }
  const binary = findAppBinary()
  console.log(`[native] launching ${binary}`)

  const lines: Array<string> = []
  const app = Bun.spawn([binary], {
    cwd: UI_DIR,
    env: {
      ...process.env,
      ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT: String(CDP_PORT),
      SMITHERS_LOCAL_PORT: String(LOCAL_PORT),
      SMITHERS_CHAT_STUB: "1"
    },
    stdout: "pipe",
    stderr: "pipe"
  })
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const parts = buffer.split("\n")
      buffer = parts.pop() ?? ""
      for (const line of parts) {
        console.log(`  [app] ${line}`)
        lines.push(line)
      }
      if (done) break
    }
  }
  void pump(app.stdout)
  void pump(app.stderr)

  const kill = (): void => {
    try {
      app.kill("SIGKILL")
    } catch {
      // Already gone.
    }
    Bun.spawnSync(["pkill", "-f", "Smithers-dev.app/Contents/MacOS"], { stdout: "ignore", stderr: "ignore" })
  }

  let code = 1
  try {
    const origin = `http://127.0.0.1:${LOCAL_PORT}`
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    let originUp = false
    while (Date.now() < deadline) {
      originUp = await fetch(`${origin}/api/health`).then((response) => response.ok).catch(() => false)
      if (originUp) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!originUp) fail(`the app never served ${origin}/api/health within ${LAUNCH_TIMEOUT_MS}ms`)
    console.log(`[native] origin up at ${origin}`)

    const cdp = `http://127.0.0.1:${CDP_PORT}`
    let cdpUp = false
    while (Date.now() < deadline) {
      cdpUp = await fetch(`${cdp}/json/version`).then((response) => response.ok).catch(() => false)
      if (cdpUp) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!cdpUp) {
      fail(
        `no CDP endpoint on ${cdp}. The build must bundle CEF (electrobun.config.ts mac.bundleCEF) for ` +
          "ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT to take effect."
      )
    }
    console.log(`[native] CDP up at ${cdp}`)

    code = await run(["pnpm", "exec", "playwright", "test", "--config", "playwright.native.config.ts"], {
      SMITHERS_NATIVE_CDP: cdp,
      SMITHERS_NATIVE_ORIGIN: origin
    })
  } finally {
    kill()
  }
  process.exit(code)
}

await main()
