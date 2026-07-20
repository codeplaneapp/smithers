import type { CachedPrompt, PromptCache } from "./PromptCache";

/**
 * In-memory cache. Useful for tests and short-lived workflows. Not durable.
 */
export class MemoryPromptCache implements PromptCache {
  private readonly store = new Map<string, CachedPrompt>();

  async get(key: string): Promise<CachedPrompt | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: CachedPrompt): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }
}
