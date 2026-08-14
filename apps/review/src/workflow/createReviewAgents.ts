import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentLike } from "@smthrs/agents";
import { ClaudeCodeAgent } from "@smthrs/agents/ClaudeCodeAgent";
import { CodexAgent } from "@smthrs/agents/CodexAgent";
import { nativeReviewAgentOutputSchema } from "./openCodeReview";
import { quizSchema } from "../quiz/quizSchema";
import { storySchema } from "../walkthrough/storySchema";
import { verifyVerdictsSchema } from "./verifyVerdictsSchema";
import { writeOpenAiSchemaFile } from "./writeOpenAiSchemaFile";

type RegisteredCodexCredential = { provider: "codex"; configDir: string } | { provider: "openai-api"; apiKey: string };

export function registeredReviewCodexCredentials(env: NodeJS.ProcessEnv = process.env): RegisteredCodexCredential[] {
  const root = env.SMITHERS_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".smithers");
  try {
    const parsed = JSON.parse(readFileSync(join(root, "accounts.json"), "utf8"));
    if (!Array.isArray(parsed?.accounts)) return [];
    return parsed.accounts.flatMap((account: any): RegisteredCodexCredential[] => {
      if (account?.provider === "codex" && typeof account.configDir === "string" && account.configDir.trim()) {
        return [{ provider: "codex", configDir: account.configDir.trim() }];
      }
      if (account?.provider === "openai-api" && typeof account.apiKey === "string" && account.apiKey.trim()) {
        return [{ provider: "openai-api", apiKey: account.apiKey.trim() }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

/**
 * Default agent arrays for review and narration.
 *
 * Engine selection is keyed on `SMITHERS_REVIEW_ENGINE`:
 *
 * - `codex` (default when installed and authenticated): Sol reviews/verifies; Luna narrates and
 *   writes quizzes. Auth comes from `~/.codex/auth.json` (or `$CODEX_HOME`), which the
 *   cloud action writes from a `CODEX_AUTH_JSON` secret. This is the BYO path
 *   for repos owned by the subscription holder.
 * - `claude`: no-Codex fallback using Fable primary and Opus failover.
 *
 * Claude auth selection: when both `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`
 * are set, build the agents in API-key mode. This is the metered-proxy path the
 * cloud action takes — the service mints a session-scoped key and points the
 * CLI at the proxy, and ClaudeCodeAgent must forward that key to the spawned
 * `claude` binary (its default is to *clear* `ANTHROPIC_API_KEY` so subscription
 * auth wins). Otherwise (local dev, BYO Claude via CLAUDE_CODE_OAUTH_TOKEN) keep
 * subscription mode.
 */
function hasUsableCodex(): boolean {
  const executable = Bun.which("codex");
  if (!executable) return false;
  if (process.env.OPENAI_API_KEY?.trim().startsWith("sk-")) return true;
  if (registeredReviewCodexCredentials().length > 0) return true;
  try {
    execFileSync(executable, ["login", "status"], {
      env: process.env,
      stdio: "ignore",
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveReviewEngine(codexAvailable: () => boolean = hasUsableCodex): "codex" | "claude" {
  const requested = process.env.SMITHERS_REVIEW_ENGINE?.trim().toLowerCase();
  if (requested === "codex" || requested === "claude") return requested;
  return codexAvailable() ? "codex" : "claude";
}

export function createReviewAgents(repoDir: string): {
  review: AgentLike[];
  narrate: AgentLike[];
  verify: AgentLike[];
  quiz: AgentLike[];
} {
  const engine = resolveReviewEngine();

  const createClaudePool = (useReviewModel: boolean): AgentLike[] => {
    const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    const proxyMode = Boolean(baseUrl && apiKey);
    const primaryModel = useReviewModel
      ? process.env.SMITHERS_REVIEW_MODEL?.trim() || "claude-fable-5"
      : "claude-fable-5";
    const fallbackModel = process.env.SMITHERS_REVIEW_FALLBACK_MODEL?.trim() || "claude-opus-4-8";
    const primary = proxyMode
      ? new ClaudeCodeAgent({ model: primaryModel, cwd: repoDir, apiKey })
      : new ClaudeCodeAgent({ model: primaryModel, cwd: repoDir });
    const fallback = proxyMode
      ? new ClaudeCodeAgent({ model: fallbackModel, cwd: repoDir, apiKey })
      : new ClaudeCodeAgent({ model: fallbackModel, cwd: repoDir });
    return [primary, fallback];
  };

  if (engine === "codex") {
    const reviewModel = process.env.SMITHERS_REVIEW_MODEL?.trim() || "gpt-5.6-sol";
    const cheapModel = process.env.SMITHERS_REVIEW_CHEAP_MODEL?.trim() || "gpt-5.6-luna";
    const configDir = process.env.CODEX_HOME?.trim() || undefined;
    // Codex's `--json` event stream is verbose (reasoning, tool, token events).
    // On a real diff it blows past the default stdout cap, which sets
    // `stdoutTruncated` and makes the engine fall back to the streamed
    // interpreter answer (the model's short `message`) instead of the complete
    // `--output-last-message` JSON. Raise the cap so the structured output
    // survives. (#277-adjacent.)
    const maxOutputBytes = 64 * 1024 * 1024;
    const base = { cwd: repoDir, skipGitRepoCheck: true, maxOutputBytes, ...(configDir ? { configDir } : {}) };
    // Per-task --output-schema keeps each stage pinned to its expected JSON.
    const smart = { ...base, model: reviewModel, config: { model_reasoning_effort: "xhigh" as const } };
    const cheap = { ...base, model: cheapModel, config: { model_reasoning_effort: "medium" as const } };
    const credentials = registeredReviewCodexCredentials().filter((credential) =>
      credential.provider === "codex"
        ? credential.configDir !== configDir
        : credential.apiKey !== process.env.OPENAI_API_KEY?.trim(),
    );
    const codexPool = (options: ConstructorParameters<typeof CodexAgent>[0]): AgentLike[] => [
      new CodexAgent(options),
      ...credentials.map(
        (credential) =>
          new CodexAgent({
            ...options,
            configDir: credential.provider === "codex" ? credential.configDir : undefined,
            apiKey: credential.provider === "openai-api" ? credential.apiKey : undefined,
          }),
      ),
    ];
    const claudeFallbacks = createClaudePool(false);
    const review = [
      ...codexPool({ ...smart, outputSchema: writeOpenAiSchemaFile(nativeReviewAgentOutputSchema) }),
      ...claudeFallbacks,
    ];
    const narrate = [...codexPool({ ...cheap, outputSchema: writeOpenAiSchemaFile(storySchema) }), ...claudeFallbacks];
    const verify = [
      ...codexPool({ ...smart, outputSchema: writeOpenAiSchemaFile(verifyVerdictsSchema) }),
      ...claudeFallbacks,
    ];
    const quiz = [...codexPool({ ...cheap, outputSchema: writeOpenAiSchemaFile(quizSchema) }), ...claudeFallbacks];
    return { review, narrate, verify, quiz };
  }

  const pool = createClaudePool(true);
  return { review: pool, narrate: pool, verify: pool, quiz: pool };
}
