import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { findProductionAppExecutable } from "./PackagedApp"

const UI_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url))
const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-")

const run = async (label: string, argv: ReadonlyArray<string>, env: Record<string, string> = {}): Promise<void> => {
  console.log(`[packaged-e2e] ${label}: ${argv.join(" ")}`)
  const child = Bun.spawn([...argv], {
    cwd: UI_DIRECTORY,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit"
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${label} failed with exit code ${exitCode}.`)
}

const main = async (): Promise<void> => {
  if (process.platform !== "darwin") {
    console.log("SKIP: packaged Electrobun E2E currently supports macOS only.")
    return
  }

  const suppliedExecutable = process.env.SMITHERS_E2E_EXECUTABLE
  if (suppliedExecutable === undefined && process.env.SMITHERS_E2E_SKIP_BUILD !== "1") {
    await run("project devkit", [process.execPath, "scripts/ensure-devkit.mjs"])
    await run("production web bundle", ["pnpm", "exec", "vite", "build", "--configLoader", "runner"])
    await run("stable Electrobun package", ["pnpm", "exec", "electrobun", "build", "--env=stable"])
  }

  const executable = suppliedExecutable === undefined
    ? await findProductionAppExecutable(UI_DIRECTORY)
    : resolve(suppliedExecutable)
  const artifacts = resolve(
    process.env.SMITHERS_E2E_ARTIFACTS ?? join(UI_DIRECTORY, "test-results", "electrobun-packaged", timestamp)
  )
  await mkdir(artifacts, { recursive: true })
  console.log(`[packaged-e2e] executable: ${executable}`)
  console.log(`[packaged-e2e] artifacts: ${artifacts}`)

  await run(
    "Bun packaged-app suite",
    [process.execPath, "test", "--timeout", "180000", "e2e/packaged/packaged-app.e2e.test.ts"],
    {
      SMITHERS_E2E_EXECUTABLE: executable,
      SMITHERS_E2E_ARTIFACTS: artifacts
    }
  )
}

await main().catch((error) => {
  console.error(`[packaged-e2e] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
