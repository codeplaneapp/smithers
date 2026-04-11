import { Effect, Layer } from "effect";
import { createMemoryStoreLayer } from "./store/createMemoryStoreLayer";
import { MemoryStoreService } from "./store/MemoryStoreService";
import { createSemanticMemory } from "./semantic";
import { MemoryService } from "./MemoryService";
import type { MemoryLayerConfig } from "./MemoryLayerConfig";

export function createMemoryLayer(config: MemoryLayerConfig) {
  const semantic =
    config.vectorStore && config.embeddingModel
      ? createSemanticMemory(config.vectorStore, config.embeddingModel)
      : null;

  const noSemanticError = (): Effect.Effect<never, any> =>
    Effect.fail({
      _tag: "SmithersError",
      code: "MEMORY_SEMANTIC_NOT_CONFIGURED",
      message: "Semantic memory requires vectorStore and embeddingModel in config",
    } as any);

  return Layer.effect(
    MemoryService,
    Effect.map(MemoryStoreService, (store) => ({
      // Working memory
      getFact: (ns: any, key: any) => store.getFactEffect(ns, key),
      setFact: (ns: any, key: any, value: any, ttlMs?: any) =>
        store.setFactEffect(ns, key, value, ttlMs),
      deleteFact: (ns: any, key: any) => store.deleteFactEffect(ns, key),
      listFacts: (ns: any) => store.listFactsEffect(ns),

      // Semantic
      remember: (ns: any, content: any, metadata?: any) =>
        semantic
          ? semantic.rememberEffect(ns, content, metadata)
          : noSemanticError(),
      recall: (ns: any, query: any, recallConfig?: any) =>
        semantic
          ? semantic.recallEffect(ns, query, recallConfig)
          : noSemanticError(),

      // Threads & messages
      createThread: (ns: any, title?: any) => store.createThreadEffect(ns, title),
      getThread: (threadId: any) => store.getThreadEffect(threadId),
      deleteThread: (threadId: any) => store.deleteThreadEffect(threadId),
      saveMessage: (msg: any) => store.saveMessageEffect(msg),
      listMessages: (threadId: any, limit?: any) =>
        store.listMessagesEffect(threadId, limit),
      countMessages: (threadId: any) => store.countMessagesEffect(threadId),

      // Maintenance
      deleteExpiredFacts: () => store.deleteExpiredFactsEffect(),

      // Access underlying stores
      store,
      semantic,
    })),
  ).pipe(Layer.provide(createMemoryStoreLayer(config.db)));
}
