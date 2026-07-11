/**
 * PR automation is intentionally proxy-only. Long-lived provider
 * subscriptions belong to the local CLI trust boundary and are never an
 * accepted input to the GitHub Action.
 */
export interface ResolveInferenceEnvInput {
  anthropicBaseUrl: string;
  sessionToken: string;
}

export interface ResolvedInferenceEnv {
  mode: "proxy";
  env: {
    SMITHERS_REVIEW_ENGINE: "claude";
    ANTHROPIC_BASE_URL: string;
    ANTHROPIC_API_KEY: string;
  };
}

export function resolveInferenceEnv(input: ResolveInferenceEnvInput): ResolvedInferenceEnv {
  return {
    mode: "proxy",
    env: {
      // Pin the engine even if a self-hosted runner happens to have another
      // provider CLI or ambient login installed.
      SMITHERS_REVIEW_ENGINE: "claude",
      ANTHROPIC_BASE_URL: input.anthropicBaseUrl,
      ANTHROPIC_API_KEY: input.sessionToken,
    },
  };
}
