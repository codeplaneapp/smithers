/**
 * The state the ledger records for one instance, and whether it is finished.
 *
 *   node lib/fullbench-state.mjs <manifest.jsonl> <instance-id>
 *
 * Prints the state that instance's last row names — nothing when the ledger
 * holds no row for it — and exits 0 when that state means finished, 1 when it
 * does not, and 3 when the ledger could not be read at all. Unreadable is not
 * unfinished: the caller must not act on a state this could not determine.
 *
 * The driver asks this about a worker it had to reap without a completion
 * marker, because a marker is not an instance. A wrapper killed after its last
 * row was written, or one whose marker write failed on a full disk, lost the
 * marker and not the work, and recording that instance as failed would send an
 * instance the evaluator has already graded back through the whole pipeline on
 * the next resume. `lib/fullbench-manifest.mjs` owns which states mean
 * finished; this only asks it.
 */
import { isDone, read } from "./fullbench-manifest.mjs"

const main = () => {
  const [, , manifestPath, id] = process.argv
  if (manifestPath === undefined || id === undefined) {
    console.error("usage: node lib/fullbench-state.mjs <manifest.jsonl> <instance-id>")
    process.exit(2)
  }
  let manifest
  try {
    manifest = read(manifestPath)
  } catch (error) {
    console.error(`fullbench-state.mjs: ${manifestPath} could not be read: ${error.message}`)
    process.exit(3)
  }
  const state = manifest.states.get(id)
  if (state !== undefined && typeof state.state === "string") process.stdout.write(state.state)
  process.exit(isDone(state) ? 0 : 1)
}

main()
