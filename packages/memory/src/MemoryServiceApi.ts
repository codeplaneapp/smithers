import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { RetrievalResult } from "@smithers/rag/types";
import type { MemoryNamespace } from "./MemoryNamespace";
import type { MemoryFact } from "./MemoryFact";
import type { MemoryThread } from "./MemoryThread";
import type { MemoryMessage } from "./MemoryMessage";
import type { SemanticRecallConfig } from "./SemanticRecallConfig";
import type { MemoryStore } from "./store/MemoryStore";
import type { SemanticMemory } from "./semantic";

export type MemoryServiceApi = {
  // Working memory
  readonly getFact: (
    ns: MemoryNamespace,
    key: string,
  ) => Effect.Effect<MemoryFact | undefined, SmithersError>;
  readonly setFact: (
    ns: MemoryNamespace,
    key: string,
    value: unknown,
    ttlMs?: number,
  ) => Effect.Effect<void, SmithersError>;
  readonly deleteFact: (
    ns: MemoryNamespace,
    key: string,
  ) => Effect.Effect<void, SmithersError>;
  readonly listFacts: (
    ns: MemoryNamespace,
  ) => Effect.Effect<MemoryFact[], SmithersError>;

  // Semantic recall
  readonly remember: (
    ns: MemoryNamespace,
    content: string,
    metadata?: Record<string, unknown>,
  ) => Effect.Effect<void, SmithersError>;
  readonly recall: (
    ns: MemoryNamespace,
    query: string,
    config?: SemanticRecallConfig,
  ) => Effect.Effect<RetrievalResult[], SmithersError>;

  // Threads & messages
  readonly createThread: (
    ns: MemoryNamespace,
    title?: string,
  ) => Effect.Effect<MemoryThread, SmithersError>;
  readonly getThread: (
    threadId: string,
  ) => Effect.Effect<MemoryThread | undefined, SmithersError>;
  readonly deleteThread: (
    threadId: string,
  ) => Effect.Effect<void, SmithersError>;
  readonly saveMessage: (
    msg: Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number },
  ) => Effect.Effect<void, SmithersError>;
  readonly listMessages: (
    threadId: string,
    limit?: number,
  ) => Effect.Effect<MemoryMessage[], SmithersError>;
  readonly countMessages: (
    threadId: string,
  ) => Effect.Effect<number, SmithersError>;

  // Maintenance
  readonly deleteExpiredFacts: () => Effect.Effect<number, SmithersError>;

  // Access underlying stores
  readonly store: MemoryStore;
  readonly semantic: SemanticMemory | null;
};
