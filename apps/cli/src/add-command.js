import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Run the seeded add system workflow when the local pack has already been
 * bootstrapped. First-time installs and damaged packs fall back to addPack so
 * the public command remains usable even before the durable workflow exists.
 */
export async function runDurableAdd({ spec, global = false, yes = false } = {}) {
  if (global) return null;
  const entryFile = resolve(process.cwd(), ".smithers", "workflows", "add.tsx");
  if (!existsSync(entryFile)) return null;
  try {
    const [{ Effect }, { runWorkflow }, { ensureSmithersTables }, { mdxPlugin }] = await Promise.all([
      import("effect"),
      import("@smithers-orchestrator/engine"),
      import("@smithers-orchestrator/db/ensure"),
      import("./mdx-plugin.js"),
    ]);
    mdxPlugin();
    const workflow = (await import(pathToFileURL(entryFile).href)).default;
    if (!workflow) return null;
    ensureSmithersTables(workflow.db);
    try {
      const result = await Effect.runPromise(runWorkflow(workflow, {
        input: { spec, global, yes },
        runId: crypto.randomUUID(),
        workflowPath: entryFile,
      }));
      // A run that ended failed/cancelled must never reach c.ok as a success.
      // Fall back to the imperative path, which re-attempts and surfaces the
      // real installation error with a non-zero exit.
      if (!result || result.status !== "finished") {
        process.stderr.write(`[smithers:add] durable add ended ${result?.status ?? "without a result"}; retrying imperatively\n`);
        return null;
      }
      return result;
    } finally {
      const close = workflow.close ?? workflow.db?.close;
      if (typeof close === "function") await close.call(workflow.close ? workflow : workflow.db);
    }
  } catch (error) {
    process.stderr.write(`[smithers:add] durable add unavailable, falling back: ${error?.message ?? String(error)}\n`);
    return null;
  }
}
