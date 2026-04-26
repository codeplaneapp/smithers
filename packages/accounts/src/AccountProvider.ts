/**
 * The provider behind a registered account. Subscription providers are
 * authenticated by a CLI config directory; API providers are authenticated by
 * an API key.
 */
export type AccountProvider =
  | "claude-code"
  | "codex"
  | "gemini"
  | "kimi"
  | "anthropic-api"
  | "openai-api"
  | "gemini-api";
