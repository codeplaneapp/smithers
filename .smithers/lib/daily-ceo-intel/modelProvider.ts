/**
 * SDK-agent provider selection for daily-ceo-intel's in-process tasks (assess,
 * curate-lighter-side, compose-editorial). Anthropic is the spec-preferred
 * provider; auto mode probes it once at run start and falls back to OpenAI,
 * then Gemini, so a billing/auth outage on one provider doesn't block
 * publishing. Refunding Anthropic credits restores the original behavior with
 * zero config changes since the probe always tries Anthropic first.
 *
 * "GeminiAgent" in packages/agents is a sunset CLI wrapper (throws on
 * generate()), not an in-process SDK client — Gemini access here goes through
 * OpenAIAgent pointed at Google's OpenAI-compatible endpoint, same pattern the
 * repo already uses for the (currently unauthenticated) `gemini1` provider in
 * .smithers/agents.ts.
 */
import { OpenAIAgent, type AgentLike } from "smithers-orchestrator";

export const MODEL_PROVIDER_NAMES = ["anthropic", "openai", "gemini"] as const;
export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];
export type ModelProviderMode = "auto" | ModelProviderName;

export type ProbeClassification = "ok" | "missing-key" | "auth" | "billing" | "network" | "other";

export type ProviderProbe = {
  provider: ModelProviderName;
  attempted: boolean;
  ok: boolean;
  classification: ProbeClassification;
  detail: string;
};

export type ProviderSelection = {
  mode: ModelProviderMode;
  provider: ModelProviderName;
  cheapModel: string;
  strongModel: string;
  reason: string;
  probes: ProviderProbe[];
  selectedAt: string;
};

export const ANTHROPIC_CHEAP_MODEL = "claude-haiku-4-5-20251001";
export const ANTHROPIC_STRONG_MODEL = "claude-fable-5";
export const OPENAI_STRONG_MODEL = "gpt-5.6";
export const GEMINI_MODEL = "gemini-2.5-flash";
export const GEMINI_OPENAI_COMPAT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

const NON_CHAT_MODEL_PATTERN = /audio|realtime|embedding|image|transcribe|tts|moderation|whisper|dall-e/i;

export type EnvLike = Record<string, string | undefined>;
export type FetchLike = typeof fetch;

/** Pure: parses SIGNAL_MODEL_PROVIDER. Throws on an unrecognized value — a misconfigured deploy should fail loudly, not silently degrade. */
export function resolveModelProviderMode(env: EnvLike): ModelProviderMode {
  const raw = env.SIGNAL_MODEL_PROVIDER?.trim().toLowerCase();
  if (!raw) return "auto";
  if (raw === "auto" || (MODEL_PROVIDER_NAMES as readonly string[]).includes(raw)) return raw as ModelProviderMode;
  throw new Error(`SIGNAL_MODEL_PROVIDER must be one of auto|anthropic|openai|gemini, got "${raw}"`);
}

/** Pure: classifies a failed probe response from its HTTP status + body text. */
export function classifyProbeError(status: number, bodyText: string): ProbeClassification {
  const lower = bodyText.toLowerCase();
  if (lower.includes("credit balance") || lower.includes("insufficient_quota") || (lower.includes("billing") && !lower.includes("no billing"))) return "billing";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return lower.includes("quota") || lower.includes("credit") ? "billing" : "other";
  return "other";
}

/** Pure: picks the cheapest suitable chat model from an OpenAI-shaped /v1/models id list. Returns null if nothing usable is listed. */
export function pickCheapOpenAIModel(modelIds: string[]): string | null {
  const chatCandidates = (prefix: RegExp) => modelIds.filter((id) => prefix.test(id) && !NON_CHAT_MODEL_PATTERN.test(id)).sort();

  const family = chatCandidates(/^gpt-5\.6/);
  const nano = family.find((id) => id.includes("nano"));
  if (nano) return nano;
  const mini = family.find((id) => id.includes("mini"));
  if (mini) return mini;
  if (family.length > 0) return family[0]!;

  const anyMini = chatCandidates(/mini/i);
  if (anyMini.length > 0) return anyMini[0]!;

  return null;
}

async function safeErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

async function probeAnthropic(apiKey: string | undefined, fetchImpl: FetchLike): Promise<ProviderProbe> {
  if (!apiKey) return { provider: "anthropic", attempted: false, ok: false, classification: "missing-key", detail: "ANTHROPIC_API_KEY not set" };
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ANTHROPIC_CHEAP_MODEL, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    });
    if (res.ok) return { provider: "anthropic", attempted: true, ok: true, classification: "ok", detail: "probe call succeeded" };
    const body = await safeErrorBody(res);
    return { provider: "anthropic", attempted: true, ok: false, classification: classifyProbeError(res.status, body), detail: `HTTP ${res.status}: ${body}` };
  } catch (error) {
    return { provider: "anthropic", attempted: true, ok: false, classification: "network", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function listOpenAIModels(apiKey: string, fetchImpl: FetchLike): Promise<string[]> {
  try {
    const res = await fetchImpl("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id: string }> } | null;
    return (body?.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

async function probeOpenAI(apiKey: string | undefined, fetchImpl: FetchLike): Promise<{ probe: ProviderProbe; cheapModel: string | null }> {
  if (!apiKey) return { probe: { provider: "openai", attempted: false, ok: false, classification: "missing-key", detail: "OPENAI_API_KEY not set" }, cheapModel: null };
  const modelIds = await listOpenAIModels(apiKey, fetchImpl);
  const cheapModel = pickCheapOpenAIModel(modelIds) ?? OPENAI_STRONG_MODEL;
  try {
    const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      // 16, not 1: gpt-5.6-family reasoning models spend the first tokens on
      // reasoning and 400 on max_completion_tokens: 1, which false-negatives a
      // funded, working key (verified live 2026-07-17: 1 -> HTTP 400, 16 -> 200).
      body: JSON.stringify({ model: cheapModel, max_completion_tokens: 16, messages: [{ role: "user", content: "ping" }] }),
    });
    if (res.ok) return { probe: { provider: "openai", attempted: true, ok: true, classification: "ok", detail: `verified model ${cheapModel}` }, cheapModel };
    const body = await safeErrorBody(res);
    return { probe: { provider: "openai", attempted: true, ok: false, classification: classifyProbeError(res.status, body), detail: `HTTP ${res.status}: ${body}` }, cheapModel };
  } catch (error) {
    return { probe: { provider: "openai", attempted: true, ok: false, classification: "network", detail: error instanceof Error ? error.message : String(error) }, cheapModel };
  }
}

async function probeGemini(apiKey: string | undefined, fetchImpl: FetchLike): Promise<ProviderProbe> {
  if (!apiKey) return { provider: "gemini", attempted: false, ok: false, classification: "missing-key", detail: "GEMINI_API_KEY not set" };
  try {
    // Probe the OpenAI-compat /chat/completions endpoint the agents actually
    // serve through, not the native generateContent endpoint — probing a
    // different code path than serving let an unusable provider win selection
    // (native probe 200'd while every real call 404'd on /responses).
    const res = await fetchImpl(`${GEMINI_OPENAI_COMPAT_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: GEMINI_MODEL, max_tokens: 16, messages: [{ role: "user", content: "ping" }] }),
    });
    if (res.ok) return { provider: "gemini", attempted: true, ok: true, classification: "ok", detail: "probe call succeeded" };
    const body = await safeErrorBody(res);
    return { provider: "gemini", attempted: true, ok: false, classification: classifyProbeError(res.status, body), detail: `HTTP ${res.status}: ${body}` };
  } catch (error) {
    return { provider: "gemini", attempted: true, ok: false, classification: "network", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Decide which provider serves this run's assess/lighter-side/compose tasks.
 * Explicit modes (anthropic|openai|gemini) skip probing and force that
 * provider (still resolving an OpenAI cheap model live, best-effort). Auto
 * mode probes Anthropic, then OpenAI, then Gemini in order and stops at the
 * first success; if all three fail it throws so the run surfaces a clear
 * "no usable provider" error instead of silently no-op'ing downstream tasks.
 */
export async function selectModelProvider(env: EnvLike, fetchImpl: FetchLike = fetch, now: () => string = () => new Date().toISOString()): Promise<ProviderSelection> {
  const mode = resolveModelProviderMode(env);
  const selectedAt = now();

  if (mode === "anthropic") {
    return { mode, provider: "anthropic", cheapModel: ANTHROPIC_CHEAP_MODEL, strongModel: ANTHROPIC_STRONG_MODEL, reason: "SIGNAL_MODEL_PROVIDER=anthropic forced.", probes: [], selectedAt };
  }
  if (mode === "gemini") {
    return { mode, provider: "gemini", cheapModel: GEMINI_MODEL, strongModel: GEMINI_MODEL, reason: "SIGNAL_MODEL_PROVIDER=gemini forced.", probes: [], selectedAt };
  }
  if (mode === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    const modelIds = apiKey ? await listOpenAIModels(apiKey, fetchImpl) : [];
    const cheapModel = pickCheapOpenAIModel(modelIds) ?? OPENAI_STRONG_MODEL;
    return { mode, provider: "openai", cheapModel, strongModel: OPENAI_STRONG_MODEL, reason: "SIGNAL_MODEL_PROVIDER=openai forced.", probes: [], selectedAt };
  }

  const probes: ProviderProbe[] = [];

  const anthropicProbe = await probeAnthropic(env.ANTHROPIC_API_KEY?.trim(), fetchImpl);
  probes.push(anthropicProbe);
  if (anthropicProbe.ok) {
    return { mode, provider: "anthropic", cheapModel: ANTHROPIC_CHEAP_MODEL, strongModel: ANTHROPIC_STRONG_MODEL, reason: "Anthropic probe succeeded (spec-preferred provider).", probes, selectedAt };
  }

  const { probe: openaiProbe, cheapModel: openaiCheapModel } = await probeOpenAI(env.OPENAI_API_KEY?.trim(), fetchImpl);
  probes.push(openaiProbe);
  if (openaiProbe.ok) {
    return {
      mode,
      provider: "openai",
      cheapModel: openaiCheapModel ?? OPENAI_STRONG_MODEL,
      strongModel: OPENAI_STRONG_MODEL,
      reason: `Anthropic probe failed (${anthropicProbe.classification}: ${anthropicProbe.detail}); OpenAI probe succeeded.`,
      probes,
      selectedAt,
    };
  }

  const geminiProbe = await probeGemini(env.GEMINI_API_KEY?.trim(), fetchImpl);
  probes.push(geminiProbe);
  if (geminiProbe.ok) {
    return {
      mode,
      provider: "gemini",
      cheapModel: GEMINI_MODEL,
      strongModel: GEMINI_MODEL,
      reason: `Anthropic (${anthropicProbe.classification}) and OpenAI (${openaiProbe.classification}) probes failed; Gemini probe succeeded.`,
      probes,
      selectedAt,
    };
  }

  throw new Error(
    `daily-ceo-intel: no usable model provider in auto mode — ` +
      `anthropic(${anthropicProbe.classification}: ${anthropicProbe.detail}), ` +
      `openai(${openaiProbe.classification}: ${openaiProbe.detail}), ` +
      `gemini(${geminiProbe.classification}: ${geminiProbe.detail})`,
  );
}

/**
 * Builds the AgentLike pools for the cheap (assess/lighter-side) and strong
 * (compose-editorial) roles for a resolved selection. The anthropic branch
 * reuses the existing .smithers/agents.ts pools verbatim (anthropicPools) so
 * a refunded Anthropic account is byte-for-byte the pre-fallback behavior.
 * OpenAI/Gemini agents are built here rather than as static agents.ts entries
 * because the OpenAI cheap model id is only known after the runtime /v1/models
 * probe. Never attach tools — these roles score/synthesize untrusted scraped
 * web content (see .smithers/agents.ts's ceoIntelCheap/ceoIntelStrong comment).
 */
export function buildAgentPoolsForSelection(
  selection: ProviderSelection,
  anthropicPools: { cheap: readonly AgentLike[]; strong: readonly AgentLike[] },
): { cheap: AgentLike[]; strong: AgentLike[] } {
  if (selection.provider === "anthropic") {
    return { cheap: [...anthropicPools.cheap], strong: [...anthropicPools.strong] };
  }
  if (selection.provider === "openai") {
    return {
      cheap: [new OpenAIAgent({ model: selection.cheapModel })],
      strong: [new OpenAIAgent({ model: selection.strongModel })],
    };
  }
  // gemini: routed through OpenAIAgent at Google's OpenAI-compatible endpoint
  // (see module docstring). api: "chat" is load-bearing — the provider default
  // targets /responses, which Gemini's compat layer doesn't implement (404).
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
  return {
    cheap: [new OpenAIAgent({ model: selection.cheapModel, baseURL: GEMINI_OPENAI_COMPAT_BASE_URL, apiKey: geminiApiKey, api: "chat" })],
    strong: [new OpenAIAgent({ model: selection.strongModel, baseURL: GEMINI_OPENAI_COMPAT_BASE_URL, apiKey: geminiApiKey, api: "chat" })],
  };
}
