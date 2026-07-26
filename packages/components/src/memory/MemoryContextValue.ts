export type MemoryContextValue = {
  bank?: string;
  banks?: string[];
  tags: string[];
  recall: "auto" | string | false;
  budget: "low" | "mid" | "high";
  maxTokens: number;
  primers: string[];
  retain: "on-complete" | "off";
  tools: boolean;
};
