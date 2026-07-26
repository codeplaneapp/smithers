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
  let workflow;
  let runtime;
  try {
    const [{ Effect }, { runWorkflow }, { ensureSmithersTables }, { mdxPlugin }] = await Promise.all([
      import("effect"),
      import("@smithers-orchestrator/engine"),
      import("@smithers-orchestrator/db/ensure"),
      import("./mdx-plugin.js"),
    ]);
    mdxPlugin();
    workflow = (await import(pathToFileURL(entryFile).href)).default;
    if (!workflow) return null;
    ensureSmithersTables(workflow.db);
    runtime = { Effect, runWorkflow };
  } catch (error) {
    // Fall back ONLY when the durable workflow is unavailable BEFORE any
    // execution (stale pack, missing deps). Once it runs, its outcome is
    // authoritative — re-running imperatively would fetch/extract twice and
    // duplicate partial side effects.
    process.stderr.write(`[smithers:add] durable add unavailable, falling back: ${error?.message ?? String(error)}\n`);
    return null;
  }
  try {
    const result = await runtime.Effect.runPromise(
      runtime.runWorkflow(workflow, {
        input: { spec, global, yes },
        runId: crypto.randomUUID(),
        workflowPath: entryFile,
      }),
    );
    if (!result || result.status !== "finished") {
      const detail = result?.error?.message ?? result?.error ?? `run ended ${result?.status ?? "without a result"}`;
      throw new Error(`Pack installation failed: ${detail}`);
    }
    return result;
  } finally {
    const close = workflow.close ?? workflow.db?.close;
    if (typeof close === "function") await close.call(workflow.close ? workflow : workflow.db);
  }
}
