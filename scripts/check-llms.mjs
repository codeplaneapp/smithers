#!/usr/bin/env node
/**
 * Fails when the committed documentation bundles are stale, or when the built
 * site does not serve them.
 *
 * The bundles are generated from `docs/pages`, so an edited page and an
 * unedited bundle are a contradiction: `smithers docs`, the installed skill,
 * and smithers.sh would all serve the previous text. This gate regenerates
 * them, compares the bytes, and restores the tree it found so a red check never
 * leaves a half-written artifact behind.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { repoRoot } from "./docs-contract.mjs"
import { checkedPaths } from "./optimize-llms-full.ts"

/**
 * The directory `.github/workflows/docs-deploy.yml` uploads to the host that
 * answers https://smithers.sh.
 */
export const servedRoot = join("docs", "dist", "public")

/**
 * The two bundles smithers.sh serves, and the curated bundle each one must be.
 *
 * `vocs build` runs vocs' own llms plugin, which writes its own `llms.txt` and
 * `llms-full.txt` into {@link servedRoot} at build end. That bundle carries the
 * 0.x changelog bodies, the JSX `<Task` tags, and the `smithers oneshot`
 * invocations `generate-llms.ts` excludes, and it carries no version stamp.
 * `claude-plugin/skills/smithers/SKILL.md` tells every agent to read
 * https://smithers.sh/llms-full.txt first, so serving vocs' bundle would make
 * 0.x text the first thing an agent reads. The deploy copies the curated
 * bundles over vocs' own after the build; this gate is what proves it did.
 */
export const servedBundles = [
  { name: "llms.txt", curated: join("docs", "llms.txt") },
  { name: "llms-full.txt", curated: join("docs", "llms-full.txt") }
]

/** Reports whether `vocs build` has written a site into `root`. */
export const siteIsBuilt = (root = repoRoot) => existsSync(join(root, servedRoot))

/**
 * Names every served bundle that is not the curated bundle, byte for byte.
 *
 * An unbuilt tree has nothing to serve and so has no drift: the gate runs
 * before `vocs build` in the deploy and in CI, where `docs/dist` does not
 * exist.
 */
export const servedDrift = (root = repoRoot) => {
  if (!siteIsBuilt(root)) return []
  const drift = []
  for (const bundle of servedBundles) {
    const curated = readFileSync(join(root, bundle.curated))
    const servedPath = join(root, servedRoot, bundle.name)
    if (!existsSync(servedPath)) {
      drift.push(`${servedRoot}/${bundle.name} is missing; the site must serve ${bundle.curated}`)
      continue
    }
    const served = readFileSync(servedPath)
    if (served.equals(curated)) continue
    drift.push(
      `${servedRoot}/${bundle.name} is ${served.length} bytes, not the ${curated.length} bytes of ${bundle.curated}`
    )
  }
  return drift
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined)

  const before = new Map(checkedPaths.map((path) => [path, read(join(repoRoot, path))]))

  const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "generate-llms.ts")], {
    cwd: repoRoot,
    encoding: "utf8"
  })

  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "")
    console.error("\n✗ the documentation bundles could not be generated")
    process.exit(result.status ?? 1)
  }

  const stale = checkedPaths.filter((path) => before.get(path) !== read(join(repoRoot, path)))

  if (stale.length > 0) {
    for (const path of stale) {
      const original = before.get(path)
      if (original === undefined) continue
      writeFileSync(join(repoRoot, path), original)
    }
    console.error("✗ the committed documentation bundles are out of date:")
    for (const path of stale) console.error(`    ${before.get(path) === undefined ? "missing" : "stale"}: ${path}`)
    console.error("\nRun `pnpm docs:llms` and commit the result.")
    process.exit(1)
  }

  console.log(`✓ ${checkedPaths.filter((path) => before.get(path) !== undefined).length} documentation artifact(s) are current`)

  const drift = servedDrift()

  if (drift.length > 0) {
    console.error("\n✗ the built site does not serve the curated documentation bundles:")
    for (const line of drift) console.error(`    ${line}`)
    console.error("\nRun `cp docs/llms.txt docs/llms-full.txt docs/dist/public/` after `vocs build`,")
    console.error("the way .github/workflows/docs-deploy.yml does.")
    process.exit(1)
  }

  if (siteIsBuilt()) console.log(`✓ the built site serves ${servedBundles.length} curated bundle(s)`)
}
