// The tool-execution context now lives in its own low-level package so both the
// engine and smithers can depend on it without a cycle (the engine needs
// runWithToolContext to give in-process agent tools their run context). This file
// stays as a re-export so existing relative importers keep working.
export {
  runWithToolContext,
  getToolContext,
  getToolIdempotencyKey,
  nextToolSeq,
} from "@smithers-orchestrator/tool-context";
