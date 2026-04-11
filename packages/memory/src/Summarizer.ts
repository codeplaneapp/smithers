import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { MemoryStore } from "./store/MemoryStore";
import type { MemoryProcessor } from "./MemoryProcessor";

export function Summarizer(agent: { run: (prompt: string) => Promise<any> }): MemoryProcessor {
  function processEffect(store: MemoryStore): Effect.Effect<void, SmithersError> {
    return Effect.gen(function* () {
      // Summarizer operates on a specific thread's messages, compressing
      // older messages into a summary. Without a thread context, it logs
      // and returns. This is a structural placeholder.
      yield* Effect.logInfo("Summarizer: configured — operates at thread level");
    }).pipe(
      Effect.annotateLogs({ processor: "Summarizer" }),
      Effect.withLogSpan("memory:processor:summarizer"),
    );
  }

  return {
    name: "Summarizer",
    process: (store) => Effect.runPromise(processEffect(store)),
    processEffect,
  };
}
