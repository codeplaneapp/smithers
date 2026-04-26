export type PromptSchema = "rctf" | "prd" | "freeform";
export type Stakes = "high" | "low";

export type CachedPrompt = {
  /** The logical key this entry was stored under. */
  key: string;
  /** Rendered prompt body suitable for paste into an LLM. */
  prompt: string;
  /** Schema-specific structured slots (R-C-T-F fields, PRD fields, etc.). */
  structured: Record<string, unknown>;
  schema: PromptSchema;
  stakes: Stakes;
  /** Score at the time of caching (0..1). */
  score: number;
  /** Why the agent gave this score. */
  scoreReason: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** "extracted" via interactive loop; "manual" if hand-edited. */
  source: "extracted" | "manual";
  /** True if the human shipped despite score < threshold. */
  overridden: boolean;
};

/**
 * Storage abstraction for extracted prompts. Drivers translate logical
 * keys to physical storage (markdown file, sqlite row, in-memory map).
 *
 * The caller never deals with file paths or table rows directly — only keys.
 */
export interface PromptCache {
  get(key: string): Promise<CachedPrompt | undefined>;
  set(key: string, value: CachedPrompt): Promise<void>;
  delete(key: string): Promise<void>;
  /** List all keys. Optional: not all drivers need to support this. */
  keys?(): Promise<string[]>;
}
