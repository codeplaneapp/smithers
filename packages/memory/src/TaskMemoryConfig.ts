import type { MemoryNamespace } from "./MemoryNamespace";

export type TaskMemoryConfig = {
  namespace?: string | MemoryNamespace;
  bank?: string;
  banks?: string[];
  tags?: string[];
  recall?:
    | "auto"
    | string
    | false
    | {
        namespace?: MemoryNamespace;
        query?: string;
        topK?: number;
      };
  budget?: "low" | "mid" | "high";
  maxTokens?: number;
  primers?: string[];
  retain?: "on-complete" | "off";
  tools?: boolean;
  remember?: {
    namespace?: MemoryNamespace;
    key?: string;
  };
  threadId?: string;
};
