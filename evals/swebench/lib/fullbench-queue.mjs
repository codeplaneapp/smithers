/**
 * The order the full benchmark runs its 500 instances in, and what is left.
 *
 *   node lib/fullbench-queue.mjs <dataset.json> <manifest.jsonl> [--all|--done|--count|--unclean]
 *
 * The order is **the seeded draw**, not the dataset's own. `lib/sample.mjs`
 * shuffles all 500 rows with mulberry32 seeded 20260818 and the rig's sample is
 * its first *n*; running the whole benchmark in that same order makes every
 * prefix a uniform random sample of SWE-bench Verified. That is what lets a
 * checkpoint at 25 instances extrapolate at all: in dataset order the first 25
 * would be 25 astropy instances and the rate would say nothing about the rest.
 * It also puts the rig's five pinned instances first, so the run's own numbers
 * on them are available early to compare against the best-of-5 matrix.
 *
 * "What is left" is read from the manifest by one rule, `isDone`: an instance
 * whose last row is `graded` or `cleaned` is skipped, and everything else runs
 * from the top. An instance interrupted between `pulled` and `graded` is
 * therefore re-run in full rather than resumed in the middle, because the only
 * artifact a half-run leaves is a workspace whose journal may or may not have
 * been flushed.
 *
 * Spends nothing, needs no docker.
 */
import { readFileSync } from "node:fs"
import { isDone, read } from "./fullbench-manifest.mjs"
import { PINNED, sample } from "./sample.mjs"

/**
 * Every instance id, in seeded draw order, with the pinned head asserted.
 *
 * @category conversions
 * @since 0.1.0
 */
export const drawOrder = (rows) => {
  const ids = sample(rows, rows.length).map((row) => row.instance_id)
  // The same assertion `lib/sample.mjs` makes, over the whole draw rather than
  // its first eight: a dataset holding SWE-bench Verified must draw the five
  // pinned instances first, or the dataset revision or the procedure changed
  // and every committed number is about different instances.
  //
  // A dataset that does not hold them at all is not SWE-bench Verified — it is
  // the stub the rig's own dry run builds — and is only allowed to be smaller
  // than the pinned set, so no real dataset can slip through as one.
  const present = new Set(ids)
  const holdsPinned = PINNED.every((id) => present.has(id))
  if (!holdsPinned) {
    if (rows.length > PINNED.length) {
      throw new Error(
        `a dataset of ${rows.length} rows that does not contain the pinned instances is not SWE-bench Verified`
      )
    }
    return ids
  }
  const head = ids.slice(0, PINNED.length)
  if (head.join("|") !== PINNED.join("|")) {
    throw new Error(
      `the seeded draw did not reproduce the pinned instances: expected ${PINNED.join(", ")}, got ${head.join(", ")}`
    )
  }
  return ids
}

const main = () => {
  const [, , datasetPath, manifestPath, mode = "--remaining"] = process.argv
  if (datasetPath === undefined || manifestPath === undefined) {
    console.error("usage: node lib/fullbench-queue.mjs <dataset.json> <manifest.jsonl> [--all|--done|--count]")
    process.exit(2)
  }
  const rows = JSON.parse(readFileSync(datasetPath, "utf8"))
  const ids = drawOrder(rows)
  const manifest = read(manifestPath)
  const remaining = ids.filter((id) => !isDone(manifest.states.get(id)))
  const done = ids.filter((id) => isDone(manifest.states.get(id)))

  switch (mode) {
    case "--all":
      process.stdout.write(`${ids.join("\n")}\n`)
      break
    case "--done":
      if (done.length > 0) process.stdout.write(`${done.join("\n")}\n`)
      break
    case "--count":
      process.stdout.write(`${done.length} ${remaining.length} ${ids.length}\n`)
      break
    // Instances that are finished as far as resume is concerned but never
    // reached `cleaned`: a kill between the verdict and the `docker rmi`. They
    // are the only instances nothing ever visits again, so their images are the
    // only ones that can be orphaned for the rest of the benchmark. One
    // `<id> <image>` line each, for the driver's startup sweep.
    case "--unclean": {
      const rows = done
        .map((id) => manifest.states.get(id))
        .filter((state) => state.state !== "cleaned" && typeof state.image === "string")
        .map((state) => `${state.id} ${state.image}`)
      if (rows.length > 0) process.stdout.write(`${rows.join("\n")}\n`)
      break
    }
    case "--remaining":
      if (remaining.length > 0) process.stdout.write(`${remaining.join("\n")}\n`)
      break
    default:
      console.error(`fullbench-queue.mjs: unknown mode '${mode}'`)
      process.exit(2)
  }
}

if (import.meta.filename === process.argv[1]) main()
