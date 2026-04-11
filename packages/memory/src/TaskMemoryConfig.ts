import type { MemoryNamespace } from "./MemoryNamespace";

export type TaskMemoryConfig = {
  namespace?: string | MemoryNamespace;
  recall?: {
    namespace?: MemoryNamespace;
    query?: string;
    topK?: number;
  };
  remember?: {
    namespace?: MemoryNamespace;
    key?: string;
  };
  threadId?: string;
};
