export type MemoryRuntimeRecallResult = {
  text: string;
  bank?: string;
  context?: string | null;
  occurred_start?: string | null;
  occurred_end?: string | null;
  mentioned_at?: string | null;
};

export type MemoryRuntimeService = {
  recallMemory(input: {
    banks: string[];
    query: string;
    tags?: string[];
    budget?: "low" | "mid" | "high";
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<MemoryRuntimeRecallResult[]>;
  getPrimers(input: {
    banks: string[];
    primerIds: string[];
    signal?: AbortSignal;
  }): Promise<Array<{ bank?: string; id: string; content: string }>>;
  retainMemory(input: {
    bank: string;
    content: string;
    tags?: string[];
    metadata?: Record<string, string>;
    documentId: string;
    updateMode?: "replace" | "append";
    async?: boolean;
    context?: string;
    signal?: AbortSignal;
  }): Promise<void>;
};
