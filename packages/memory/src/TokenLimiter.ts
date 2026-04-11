import { Effect } from "effect";
import { runPromise } from "@smithers/runtime/runtime";
import type { SmithersError } from "@smithers/core/errors";
import type { MemoryStore } from "./store/MemoryStore";
import type { MemoryProcessor } from "./MemoryProcessor";

export function TokenLimiter(maxTokens: number): MemoryProcessor {
  // Rough approximation: 1 token ~= 4 characters
  const charBudget = maxTokens * 4;

  function processEffect(store: MemoryStore): Effect.Effect<void, SmithersError> {
    return Effect.gen(function* () {
      // Token limiter operates at the thread level; without a specific thread
      // context it logs and returns. In practice, this processor is invoked
      // with a store that wraps a specific thread. For now, this is a no-op
      // placeholder that documents the intended behaviour.
      yield* Effect.logInfo(
        `TokenLimiter: configured for ${maxTokens} tokens (${charBudget} chars) — operates at thread level`,
      );
    }).pipe(
      Effect.annotateLogs({ processor: "TokenLimiter", maxTokens }),
      Effect.withLogSpan("memory:processor:token-limiter"),
    );
  }

  return {
    name: "TokenLimiter",
    process: (store) => runPromise(processEffect(store)),
    processEffect,
  };
}
