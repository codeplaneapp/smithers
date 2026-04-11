import { Effect } from "effect";
import { runPromise } from "@smithers/runtime/runtime";
import type { SmithersError } from "@smithers/core/errors";
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
    process: (store) => runPromise(processEffect(store)),
    processEffect,
  };
}
