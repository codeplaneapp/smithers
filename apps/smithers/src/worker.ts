import { chat, toServerSentEventsResponse, type StreamChunk } from "@tanstack/ai";
import { openaiCompatible } from "@tanstack/ai-openai/compatible";
import type { CloudflareEnv } from "./env";

/** Cerebras' OpenAI-compatible Chat Completions endpoint. */
const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

/** The Cerebras model the chat runs on — the very fast gpt-oss-120b. */
const CEREBRAS_MODEL = "gpt-oss-120b";

type ChatBody = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Optional system prompt prepended to the conversation. */
  system?: string;
};

/**
 * POST /api/chat — runs the Cerebras chat on the server via TanStack AI and
 * streams the reply back as Server-Sent Events. The Cerebras key is a Worker
 * secret, so it never reaches the browser.
 */
async function handleChat(request: Request, env: CloudflareEnv): Promise<Response> {
  if (!env.CEREBRAS_API_KEY) {
    return new Response("Server is missing CEREBRAS_API_KEY", { status: 500 });
  }

  let body: ChatBody;
  try {
    body = (await request.json()) as ChatBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (!Array.isArray(body.messages)) {
    return new Response("Request body must include messages[]", { status: 400 });
  }

  const cerebras = openaiCompatible({
    name: "cerebras",
    baseURL: CEREBRAS_BASE_URL,
    apiKey: env.CEREBRAS_API_KEY,
    models: [CEREBRAS_MODEL],
  });

  const stream = chat({
    adapter: cerebras(CEREBRAS_MODEL),
    messages: body.messages,
    systemPrompts: body.system ? [body.system] : undefined,
  }) as AsyncIterable<StreamChunk>;

  return toServerSentEventsResponse(stream);
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return handleChat(request, env);
    }

    // Static assets (and the SPA fallback) are served by the platform before a
    // request reaches the Worker. Anything else that lands here is handed to the
    // assets binding when present, otherwise it's a genuine 404.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
