/**
 * Decide how the review subprocess authenticates its agents, in priority order:
 *
 * 1. Codex / ChatGPT subscription — when `CODEX_AUTH_JSON` is present (the repo
 *    owner's `~/.codex/auth.json`). The engine switches to codex (`gpt-5.5`) and
 *    no ANTHROPIC_* overrides are set; the caller writes the auth file and sets
 *    CODEX_HOME before spawning.
 * 2. Claude subscription — when `CLAUDE_CODE_OAUTH_TOKEN` is present. The engine
 *    stays on Claude with no ANTHROPIC_* overrides, so the claude CLI uses
 *    subscription auth.
 * 3. Metered proxy (default) — inference goes through the service's Anthropic
 *    proxy using the session token.
 *
 * Publishing and quota are session-scoped and unaffected by this choice; only
 * inference moves off the proxy in the subscription modes.
 */
export interface ResolveInferenceEnvInput {
  anthropicBaseUrl: string;
  sessionToken: string;
  codexAuthJson?: string;
  claudeCodeOauthToken?: string;
}

export interface ResolvedInferenceEnv {
  mode: "codex-subscription" | "claude-subscription" | "proxy";
  /** Env overrides for the review subprocess (merged over process.env). */
  env: Record<string, string>;
}

export function resolveInferenceEnv(input: ResolveInferenceEnvInput): ResolvedInferenceEnv {
  if (input.codexAuthJson?.trim()) {
    return { mode: "codex-subscription", env: { SMITHERS_REVIEW_ENGINE: "codex" } };
  }
  if (input.claudeCodeOauthToken?.trim()) {
    return { mode: "claude-subscription", env: {} };
  }
  return {
    mode: "proxy",
    env: {
      ANTHROPIC_BASE_URL: input.anthropicBaseUrl,
      ANTHROPIC_API_KEY: input.sessionToken,
    },
  };
}
