/**
 * Scripted deploy: build the TanStack Start client and Worker (apps/ui), then
 * deploy that generated Wrangler bundle, recording a receipt (git sha +
 * timestamp + wrangler version id) either way.
 *
 *   bun scripts/deploy.ts --dry-run
 *     Runs the real vite build, then `wrangler deploy --dry-run` — no
 *     Cloudflare credentials needed, nothing published. Receipt lands in
 *     deploy-receipts/dry-run/.
 *
 *   bun scripts/deploy.ts
 *     Real deploy. Requires CLOUDFLARE_API_TOKEN (or `wrangler login`).
 *     Receipt lands in deploy-receipts/.
 *
 * The Worker identity (name `smithers-mvp-web`, the canary.smithers.sh route)
 * is frozen — see apps/server/DEPLOY.md and wrangler.jsonc:1-9. This script
 * never changes wrangler.jsonc; it only builds and deploys what's there.
 *
 * CN-1: the receipt records the sha the SPA bundle was stamped with, not a sha
 * read afterwards, so `scripts/canary/build-probe.ts` can hold the deployment
 * to the claim.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const dryRun = process.argv.includes("--dry-run")

const serverDir = fileURLToPath(new URL("..", import.meta.url))
const uiDir = fileURLToPath(new URL("../../ui", import.meta.url))

const run = async (
  cmd: ReadonlyArray<string>,
  options: { cwd: string; capture?: boolean; env?: Record<string, string> }
): Promise<{ exitCode: number; output: string }> => {
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdout: options.capture === true ? "pipe" : "inherit",
    stderr: "inherit"
  })
  const output = options.capture === true ? await new Response(proc.stdout).text() : ""
  if (options.capture === true) process.stdout.write(output)
  const exitCode = await proc.exited
  return { exitCode, output }
}

/*
 * The sha is read BEFORE the build, not after, because the build consumes it:
 * apps/ui/vite.config.ts's buildStamp plugin writes SMITHERS_BUILD_SHA into
 * the bundle as /__build.json and as a meta tag on the HTML. The receipt below
 * records the same value, so the deployment and the receipt can be compared
 * byte for byte — that comparison is CN-1, and
 * scripts/canary/build-probe.ts runs it.
 *
 * A dirty tree is recorded rather than hidden. The sha alone would claim the
 * artifact is that commit, which is not true when uncommitted work went into
 * the build.
 */
const gitSha = (await run(["git", "rev-parse", "HEAD"], { cwd: serverDir, capture: true })).output.trim()
const gitDirty = (await run(["git", "status", "--porcelain"], { cwd: serverDir, capture: true })).output.trim() !== ""

console.log(`[deploy] building TanStack Start in ${uiDir}, stamped ${gitSha}${gitDirty ? " (dirty tree)" : ""}...`)
const build = await run(["bun", "run", "build"], { cwd: uiDir, env: { SMITHERS_BUILD_SHA: gitSha } })
if (build.exitCode !== 0) {
  console.error("[deploy] vite build failed.")
  process.exit(build.exitCode)
}

console.log(`[deploy] ${dryRun ? "dry-run " : ""}wrangler deploy of the Start/Worker build...`)
const startConfig = `${uiDir}/dist/server/wrangler.json`
const deployArgs = [
  "bun",
  "x",
  "wrangler@4.124.0",
  "deploy",
  "--config",
  startConfig,
  ...(dryRun ? ["--dry-run"] : [])
]
const deploy = await run(deployArgs, { cwd: serverDir, capture: true })
if (deploy.exitCode !== 0) {
  console.error("[deploy] wrangler deploy failed.")
  process.exit(deploy.exitCode)
}

const versionIdMatch = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(deploy.output)

/*
 * A real deploy that exits 0 without printing a version id leaves CN-24 a
 * receipt it cannot use: rollback-probe.ts needs the id to assert that the
 * previous version is reachable and that the deployment matches the receipt.
 * Writing `null` and carrying on would hand the operator a rollback plan that
 * silently verifies nothing. Fail here instead, while the deploy output is
 * still on screen. A dry run legitimately prints no id, so it is exempt.
 */
if (!dryRun && versionIdMatch === null) {
  console.error("[deploy] wrangler deployed but printed no 'Current Version ID'.")
  console.error("[deploy] The receipt would carry wranglerVersionId: null, which CN-24 cannot verify.")
  console.error("[deploy] Check the wrangler output above, then re-run, or record the id by hand.")
  process.exit(1)
}

const receipt = {
  worker: "smithers-mvp-web",
  dryRun,
  gitSha,
  gitDirty,
  timestamp: new Date().toISOString(),
  wranglerVersionId: versionIdMatch?.[1] ?? null
}

const receiptDir = dryRun ? `${serverDir}deploy-receipts/dry-run` : `${serverDir}deploy-receipts`
mkdirSync(receiptDir, { recursive: true })
const receiptPath = `${receiptDir}/${receipt.timestamp.replace(/[:.]/g, "-")}.json`
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, "\t")}\n`)
writeFileSync(`${receiptDir}/latest.json`, `${JSON.stringify(receipt, null, "\t")}\n`)

console.log(`[deploy] receipt written to ${receiptPath}`)
if (!dryRun) {
  console.log(
    `[deploy] verify the deployment serves what this receipt claims:\n` +
      `         bun scripts/canary/build-probe.ts https://canary.smithers.sh --sha ${gitSha}`
  )
}
