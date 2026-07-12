import type { UsageSummary } from "./parseUsage.ts";

/**
 * Non-streaming Anthropic Messages response: one JSON object with `model`
 * and `usage.{input,output}_tokens` plus the separately-billed
 * `cache_creation_input_tokens` / `cache_read_input_tokens`. Returns null on
 * parse failure or when the body lacks a model, so the caller can skip the
 * usage row cleanly.
 */
export function parseUsageFromJson(body: string): UsageSummary | null {
  try {
    const obj = JSON.parse(body) as {
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        service_tier?: string;
        inference_geo?: string;
      };
    };
    if (!obj || typeof obj.model !== "string") return null;
    const input = obj.usage?.input_tokens ?? 0;
    const output = obj.usage?.output_tokens ?? 0;
    const cacheCreation = obj.usage?.cache_creation_input_tokens ?? 0;
    const cacheRead = obj.usage?.cache_read_input_tokens ?? 0;
    return {
      model: obj.model,
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: cacheCreation,
      cacheReadTokens: cacheRead,
      ...(typeof obj.usage?.service_tier === "string" ? { serviceTier: obj.usage.service_tier } : {}),
      ...(typeof obj.usage?.inference_geo === "string" ? { inferenceGeo: obj.usage.inference_geo } : {}),
    };
  } catch {
    return null;
  }
}
