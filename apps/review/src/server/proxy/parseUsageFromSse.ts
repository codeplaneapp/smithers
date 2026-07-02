import type { UsageSummary } from "./parseUsage.ts";

/**
 * Streaming Anthropic Messages response: `event: message_start` carries the
 * model and prompt-side usage; subsequent `event: message_delta` frames
 * carry the running output_tokens. We keep the latest value seen for each.
 *
 * Returns null when no message_start/message_delta frames appear, so the
 * proxy can skip the usage row without faulting non-content frames.
 */
export function parseUsageFromSse(stream: string): UsageSummary | null {
  let model = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let saw = false;
  const frames = stream.split(/\n\n+/);
  for (const frame of frames) {
    const lines = frame.split(/\r?\n/);
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (eventName === "message_start") {
      saw = true;
      const message = (payload.message ?? {}) as {
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      if (typeof message.model === "string") model = message.model;
      const usage = message.usage ?? {};
      if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
      if (typeof usage.cache_creation_input_tokens === "number")
        cacheCreationTokens = usage.cache_creation_input_tokens;
      if (typeof usage.cache_read_input_tokens === "number")
        cacheReadTokens = usage.cache_read_input_tokens;
    } else if (eventName === "message_delta") {
      saw = true;
      const usage = (payload.usage ?? {}) as {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
      if (typeof usage.cache_creation_input_tokens === "number")
        cacheCreationTokens = usage.cache_creation_input_tokens;
      if (typeof usage.cache_read_input_tokens === "number")
        cacheReadTokens = usage.cache_read_input_tokens;
    }
  }
  if (!saw) return null;
  return { model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens };
}
