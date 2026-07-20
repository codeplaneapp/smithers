import type { AccountProvider } from "./AccountProvider";

/**
 * A single registered account. Either `configDir` (subscription providers) or
 * `apiKey` (API providers) is set, never both. The CLI enforces this at
 * registration time.
 */
export type Account = {
  /** Unique label, e.g. "claude-work". Lowercase, kebab/snake/camel-case OK. */
  label: string;
  /** Which CLI/API this account belongs to. */
  provider: AccountProvider;
  /**
   * Absolute path to the per-account CLI config directory. Set for
   * subscription providers (claude-code, antigravity, codex, kimi).
   */
  configDir?: string;
  /**
   * Raw API key. Set for API providers (anthropic-api, openai-api,
   * gemini-api). Stored in plaintext in `~/.smithers/accounts.json` (mode 600).
   * For stricter handling, set this to the empty string and override at
   * runtime via the matching env var.
   */
  apiKey?: string;
  /** Optional default model to bake into the generated `agents.ts`. */
  model?: string;
  /** ISO timestamp of when this account was added. */
  addedAt?: string;
};
