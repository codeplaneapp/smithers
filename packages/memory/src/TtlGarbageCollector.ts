import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { MemoryStore } from "./store/MemoryStore";
import type { MemoryProcessor } from "./MemoryProcessor";

export function TtlGarbageCollector(): MemoryProcessor {
  function processEffect(store: MemoryStore): Effect.Effect<void, SmithersError> {
    return Effect.gen(function* () {
      const deleted = yield* store.deleteExpiredFactsEffect();
      yield* Effect.logInfo(`TtlGarbageCollector: deleted ${deleted} expired facts`);
    }).pipe(
      Effect.annotateLogs({ processor: "TtlGarbageCollector" }),
      Effect.withLogSpan("memory:processor:ttl-gc"),
    );
  }

  return {
    name: "TtlGarbageCollector",
    process: (store) => Effect.runPromise(processEffect(store)),
    processEffect,
  };
}
