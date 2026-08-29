/**
 * Builds the official evaluator's predictions file from collected patches.
 *
 *   node lib/make-preds.mjs <patches-dir> <model-name> <patch-suffix> <instance_id>...
 *
 * `patch-suffix` is appended to the instance id when naming the patch file, so
 * one round of a best-of-n matrix grades as `<id>-r3.patch` while the
 * predictions it produces are still keyed by `<id>` — which is the only key the
 * evaluator has. Pass an empty string for today's `<id>.patch` names.
 *
 * A missing patch file is an empty prediction, which the evaluator grades as
 * `empty patch` — the same verdict the rig reports for an agent that changed
 * nothing.
 */
import { existsSync, readFileSync } from "node:fs"

const [, , patchesDir, modelName, suffix, ...ids] = process.argv
const preds = {}
for (const id of ids) {
  const path = `${patchesDir}/${id}${suffix ?? ""}.patch`
  preds[id] = {
    instance_id: id,
    model_name_or_path: modelName,
    model_patch: existsSync(path) ? readFileSync(path, "utf8") : ""
  }
}
process.stdout.write(JSON.stringify(preds, null, 2))
