/**
 * Regenerates the seeded SWE-bench Verified sample.
 *
 *   node lib/sample.mjs <dataset.json> <out.json> [size]
 *
 * The sample is a pinned artifact, not a fresh draw: the benchmark drive
 * compares every wave against the same instances, and the run scripts, the
 * committed codex baseline, and the scorecard are all keyed to them. So the
 * procedure is fixed and asserted rather than described.
 *
 * Procedure: seed a mulberry32 PRNG with 20260818, run a standard backward
 * Fisher-Yates shuffle over the dataset rows in dataset order, take the first
 * `size`. The dataset ships sorted by `instance_id`, so the draw does not
 * depend on which of the two orders a caller believes it is using.
 *
 * The first five draws are the drive's regression suite and are asserted here.
 * If this assertion ever fails, the sample changed under the drive — stop and
 * find out why, rather than accepting a different set of instances.
 */
import { readFileSync, writeFileSync } from "node:fs"

/** The pinned seed. Changing it invalidates every committed baseline. */
export const SEED = 20260818

/** The first five draws, in draw order. The regression suite. */
export const PINNED = [
  "astropy__astropy-8707",
  "django__django-16612",
  "pydata__xarray-7393",
  "pytest-dev__pytest-6197",
  "sphinx-doc__sphinx-11445"
]

/** mulberry32: a 32-bit PRNG small enough to restate exactly, everywhere. */
export const mulberry32 = (seed) => {
  let a = seed | 0
  return () => {
    a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

/** The seeded draw: backward Fisher-Yates, then the first `size` rows. */
export const sample = (rows, size, seed = SEED) => {
  const random = mulberry32(seed)
  const shuffled = [...rows]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const swap = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = swap
  }
  return shuffled.slice(0, size)
}

const main = () => {
  const [, , datasetPath, outPath, sizeArg] = process.argv
  if (datasetPath === undefined || outPath === undefined) {
    console.error("usage: node lib/sample.mjs <dataset.json> <out.json> [size]")
    process.exit(2)
  }
  const size = Number(sizeArg ?? 8)
  const rows = JSON.parse(readFileSync(datasetPath, "utf8"))
  const drawn = sample(rows, size)
  const ids = drawn.map((row) => row.instance_id)

  const head = ids.slice(0, PINNED.length)
  if (head.join("|") !== PINNED.join("|")) {
    console.error("sample.mjs: the seeded draw did not reproduce the pinned instances.")
    console.error(`  expected: ${PINNED.join(", ")}`)
    console.error(`  got:      ${head.join(", ")}`)
    console.error("  The dataset revision or the sampling procedure changed. Do not")
    console.error("  benchmark against this sample; see README.md, 'The seeded sample'.")
    process.exit(1)
  }

  writeFileSync(outPath, `${JSON.stringify({ seed: SEED, size, instances: ids }, null, 2)}\n`)
  console.log(`sample.mjs: ${outPath} — ${ids.length} instances, pinned head verified`)
  for (const [index, id] of ids.entries()) console.log(`  ${index + 1}. ${id}`)
}

if (import.meta.filename === process.argv[1]) main()
