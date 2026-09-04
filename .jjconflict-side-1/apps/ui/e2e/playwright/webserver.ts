/*
 * The Playwright T1 web server: builds the SPA into dist/ (skip with
 * SMITHERS_SKIP_SPA_BUILD=1 when dist/ is already fresh), then runs
 * src/bun/serve.ts in this process so Playwright's shutdown kills the origin.
 */
import { fileURLToPath } from "node:url"

const UI_DIR = fileURLToPath(new URL("../../", import.meta.url))

if (process.env.SMITHERS_SKIP_SPA_BUILD !== "1") {
  // vite.config.ts imports the Hutch projection; a fresh worktree has none yet.
  const devkit = Bun.spawn([process.execPath, "scripts/ensure-devkit.mjs"], {
    cwd: UI_DIR,
    stdout: "inherit",
    stderr: "inherit"
  })
  const devkitCode = await devkit.exited
  if (devkitCode !== 0) {
    console.error(`[webserver] ensure-devkit exited ${devkitCode}`)
    process.exit(devkitCode)
  }
  console.log("[webserver] vite build")
  const build = Bun.spawn(["pnpm", "exec", "vite", "build", "--configLoader", "runner"], {
    cwd: UI_DIR,
    stdout: "inherit",
    stderr: "inherit"
  })
  const code = await build.exited
  if (code !== 0) {
    console.error(`[webserver] vite build exited ${code}`)
    process.exit(code)
  }
}

await import("../../src/bun/serve.ts")
