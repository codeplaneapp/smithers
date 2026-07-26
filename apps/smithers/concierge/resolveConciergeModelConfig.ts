export type ChatApi = "responses" | "chat-completions";

const DEFAULT_CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

// multi defaults to the codex-subscription-only "gpt-5.3-codex-spark"; the local
// OpenAI-key fallback uses a model a standard key actually has. Override via
// CHAT_MODEL / CONCIERGE_MODEL.
const DEFAULT_CHAT_MODEL = "gpt-5-mini";
const DEFAULT_CONCIERGE_CEREBRAS_MODEL = "gpt-oss-120b";

const DEFAULT_CONCIERGE_REASONING_EFFORT = "minimal";
const DEFAULT_CONCIERGE_CEREBRAS_REASONING_EFFORT = "none";

export type ConciergeModelConfig =
  | {
      provider: "cerebras";
      baseURL: string;
      apiKey: string;
      api: ChatApi;
      model: string;
      effort: string;
      usingSubscription: false;
    }
  | {
      provider: "fallback";
      model: string;
      effort: string;
    };

/**
 * Pick the concierge chat backend from env: a Cerebras key wins (its own
 * base URL + chat-completions wire API), otherwise fall back to the codex /
 * OpenAI Responses path resolved later. Model + reasoning effort follow the
 * provider-specific env overrides.
 */
export function resolveConciergeModelConfig(env: NodeJS.ProcessEnv): ConciergeModelConfig {
  const cerebrasKey = env.CEREBRAS_API_KEY?.trim();
  if (cerebrasKey) {
    return {
      provider: "cerebras",
      baseURL: env.CONCIERGE_CEREBRAS_BASE_URL ?? DEFAULT_CEREBRAS_BASE_URL,
      apiKey: cerebrasKey,
      api: "chat-completions",
      model: env.CONCIERGE_CEREBRAS_MODEL ?? env.CONCIERGE_MODEL ?? DEFAULT_CONCIERGE_CEREBRAS_MODEL,
      effort:
        env.CONCIERGE_CEREBRAS_REASONING_EFFORT ??
        env.CONCIERGE_REASONING_EFFORT ??
        DEFAULT_CONCIERGE_CEREBRAS_REASONING_EFFORT,
      usingSubscription: false,
    };
  }
  return {
    provider: "fallback",
    model: env.CONCIERGE_MODEL ?? env.CHAT_MODEL ?? DEFAULT_CHAT_MODEL,
    effort: env.CONCIERGE_REASONING_EFFORT ?? env.CHAT_REASONING_EFFORT ?? DEFAULT_CONCIERGE_REASONING_EFFORT,
  };
}
