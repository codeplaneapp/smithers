import type { MemoryNamespace } from "./MemoryNamespace";

export type SemanticRecallConfig = {
  topK?: number;
  namespace?: MemoryNamespace;
  similarityThreshold?: number;
};
