import { extractPatch } from "./extractPatch.js";
import { loadInstances } from "./loadInstances.js";
import { scorePatch } from "./scorePatch.js";

/**
 * A native Smithers {@link Scorer} that grades a SWE-Bench Pro attempt by running
 * the canonical Docker harness on the patch currently in the instance checkout.
 *
 * Attach it to the patch-generation task (`scorers={{ resolved: { scorer: swebpScorer } }}`)
 * or use it from `smithers eval` — results land in `_smithers_scorers` and are
 * visible via `smithers scores`. The score is binary: 1.0 if the task is resolved
 * (all required tests pass in the canonical image), else 0.0.
 *
 * The scorer reads `instanceId` and `repoDir` from the task input (the same
 * fields the workflow receives), so it can locate the instance metadata and the
 * working tree the agents edited.
 *
 * @type {import("@smithers-orchestrator/scorers").Scorer}
 */
export const swebpScorer = {
  id: "swe-bench-pro-resolved",
  name: "SWE-Bench Pro Resolved",
  description: "1.0 if the agent's patch makes all required tests pass in ScaleAI's canonical image, else 0.0.",
  async score({ input }) {
    const instanceId = input?.instanceId;
    const repoDir = input?.repoDir;
    if (!instanceId || !repoDir) {
      return { score: 0, reason: "scorer input missing instanceId/repoDir" };
    }
    const [instance] = loadInstances({ ids: [instanceId] });
    if (!instance) return { score: 0, reason: `unknown instance ${instanceId}` };

    const patch = extractPatch(repoDir);
    const result = await scorePatch(instance, patch, { prefix: "scorer" });
    // Mirror runInstance's `excluded-no-tests` gate: an empty-required instance
    // is vacuously "resolved" (scorePatch.js:108-115), so without this guard a
    // no-op patch would score a free 1.0. No required tests ⇒ not scorable.
    if (result.required.length === 0) {
      return { score: 0, reason: "no required tests — excluded" };
    }
    return {
      score: result.resolved ? 1 : 0,
      reason: result.resolved
        ? `resolved: ${result.required.length} required test(s) passed`
        : `unresolved: missing ${result.missing.join(", ") || "(no tests ran)"}`,
      meta: {
        required: result.required,
        passed: result.passed,
        missing: result.missing,
        patchBytes: patch.length,
      },
    };
  },
};
