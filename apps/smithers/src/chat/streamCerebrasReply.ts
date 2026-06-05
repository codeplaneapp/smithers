import { chat, type StreamChunk } from "@tanstack/ai";
import { openaiCompatible } from "@tanstack/ai-openai/compatible";

/** Cerebras' OpenAI-compatible Chat Completions endpoint. */
const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

/** The Cerebras model this app talks to — the very fast gpt-oss-120b. */
export const CEREBRAS_MODEL = "gpt-oss-120b";

export type CerebrasMessage = {
  role: "user" | "assistant";
  content: string;
};

function runErrorMessage(chunk: StreamChunk): string {
  const payload = chunk as { message?: unknown; error?: unknown };
  if (typeof payload.message === "string" && payload.message) {
    return payload.message;
  }
  if (payload.error) {
    try {
      return typeof payload.error === "string"
        ? payload.error
        : JSON.stringify(payload.error);
    } catch {
      // fall through to the generic message
    }
  }
  return "Cerebras request failed.";
}

/**
 * Stream a reply from Cerebras entirely in the browser via TanStack AI. The
 * model call goes straight to `api.cerebras.ai` — there is no backend. Yields
 * the assistant's answer one delta at a time so the UI can render as it arrives.
 *
 * The user's API key lives only in their browser and is sent to Cerebras alone.
 * `signal` lets a caller cancel an in-flight response.
 */
export async function* streamCerebrasReply({
  apiKey,
  messages,
  system,
  signal,
}: {
  apiKey: string;
  messages: CerebrasMessage[];
  /** Optional system prompt prepended ahead of the conversation. */
  system?: string;
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const cerebras = openaiCompatible({
    name: "cerebras",
    baseURL: CEREBRAS_BASE_URL,
    apiKey,
    models: [CEREBRAS_MODEL],
    // The OpenAI SDK refuses to run in a browser unless we opt in.
    dangerouslyAllowBrowser: true,
  });

  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) {
      abortController.abort();
    } else {
      signal.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });
    }
  }

  const stream = chat({
    adapter: cerebras(CEREBRAS_MODEL),
    messages,
    systemPrompts: system ? [system] : undefined,
    abortController,
  }) as AsyncIterable<StreamChunk>;

  for await (const chunk of stream) {
    if (chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta) {
      yield chunk.delta;
    } else if (chunk.type === "RUN_ERROR") {
      throw new Error(runErrorMessage(chunk));
    }
  }
}
