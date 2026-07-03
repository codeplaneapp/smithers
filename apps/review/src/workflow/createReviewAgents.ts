import { ClaudeCodeAgent, CodexAgent, type AgentLike } from "smithers-orchestrator";
import { nativeReviewAgentOutputSchema } from "./openCodeReview";
import { quizSchema } from "../quiz/quizSchema";
import { storySchema } from "../walkthrough/storySchema";
import { verifyVerdictsSchema } from "./verifyVerdictsSchema";
import { writeOpenAiSchemaFile } from "./writeOpenAiSchemaFile";

/**
 * Default agent arrays for review and narration.
 *
 * Engine selection is keyed on `SMITHERS_REVIEW_ENGINE`:
 *
 * - `codex`: run `CodexAgent` on a ChatGPT subscription. The model must be
 *   `gpt-5.5` — `gpt-5.5-codex` is rejected with HTTP 400 under ChatGPT-account
 *   auth. Auth comes from `~/.codex/auth.json` (or `$CODEX_HOME`), which the
 *   cloud action writes from a `CODEX_AUTH_JSON` secret. This is the BYO path
 *   for repos owned by the subscription holder.
 * - `claude` (default): `ClaudeCodeAgent`, Fable primary, Opus failover
 *   (mirrors .smithers/agents.ts; the ClaudeCode subscription providers are the
 *   reliable ones locally, issue #236).
 *
 * Claude auth selection: when both `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`
 * are set, build the agents in API-key mode. This is the metered-proxy path the
 * cloud action takes — the service mints a session-scoped key and points the
 * CLI at the proxy, and ClaudeCodeAgent must forward that key to the spawned
 * `claude` binary (its default is to *clear* `ANTHROPIC_API_KEY` so subscription
 * auth wins). Otherwise (local dev, BYO Claude via CLAUDE_CODE_OAUTH_TOKEN) keep
 * subscription mode.
 */
export function createReviewAgents(repoDir: string): {
  review: AgentLike[];
  narrate: AgentLike[];
  verify: AgentLike[];
  quiz: AgentLike[];
} {
  const engine = process.env.SMITHERS_REVIEW_ENGINE?.trim().toLowerCase();

  if (engine === "codex") {
    const model = process.env.SMITHERS_REVIEW_MODEL ?? "gpt-5.5";
    const configDir = process.env.CODEX_HOME?.trim() || undefined;
    // Codex's `--json` event stream is verbose (reasoning, tool, token events).
    // On a real diff it blows past the default stdout cap, which sets
    // `stdoutTruncated` and makes the engine fall back to the streamed
    // interpreter answer (the model's short `message`) instead of the complete
    // `--output-last-message` JSON. Raise the cap so the structured output
    // survives. (#277-adjacent.)
    const maxOutputBytes = 64 * 1024 * 1024;
    const base = { model, cwd: repoDir, skipGitRepoCheck: true, maxOutputBytes, ...(configDir ? { configDir } : {}) };
    // Per-task --output-schema: review, narrate, verify, and quiz tasks each
    // have their own shape, and codex enforces the schema file so gpt-5.5
    // returns the JSON the pipeline needs instead of a prose summary.
    const review = new CodexAgent({ ...base, outputSchema: writeOpenAiSchemaFile(nativeReviewAgentOutputSchema) });
    const narrate = new CodexAgent({ ...base, outputSchema: writeOpenAiSchemaFile(storySchema) });
    const verify = new CodexAgent({ ...base, outputSchema: writeOpenAiSchemaFile(verifyVerdictsSchema) });
    const quiz = new CodexAgent({ ...base, outputSchema: writeOpenAiSchemaFile(quizSchema) });
    return { review: [review], narrate: [narrate], verify: [verify], quiz: [quiz] };
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const proxyMode = Boolean(baseUrl && apiKey);

  const primaryModel = process.env.SMITHERS_REVIEW_MODEL ?? "claude-fable-5";
  const fallbackModel = process.env.SMITHERS_REVIEW_FALLBACK_MODEL ?? "claude-opus-4-8";

  const primary = proxyMode
    ? new ClaudeCodeAgent({ model: primaryModel, cwd: repoDir, apiKey })
    : new ClaudeCodeAgent({ model: primaryModel, cwd: repoDir });
  const fallback = proxyMode
    ? new ClaudeCodeAgent({ model: fallbackModel, cwd: repoDir, apiKey })
    : new ClaudeCodeAgent({ model: fallbackModel, cwd: repoDir });

  const pool = [primary, fallback];
  return { review: pool, narrate: pool, verify: pool, quiz: pool };
}
