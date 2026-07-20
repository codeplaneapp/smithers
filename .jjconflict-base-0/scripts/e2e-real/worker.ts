/**
 * Hosts the real Smithers Cloudflare Worker for real-stack e2e tests.
 *
 * This process deliberately refuses to boot without a real chat upstream key.
 * It can target Cerebras directly, or Gemini's OpenAI-compatible endpoint while
 * preserving the Worker's CEREBRAS_* binding names.
 */
import worker from "../../apps/smithers/src/worker";
import type { CloudflareEnv } from "../../apps/smithers/src/env";

const port = Number(process.env.SMITHERS_REAL_WORKER_PORT ?? 5376);

type ChatProvider = {
  name: "cerebras" | "gemini";
  apiKey: string;
  baseUrl?: string;
  model?: string;
};

function selectChatProvider(): ChatProvider {
  if (process.env.CEREBRAS_API_KEY) {
    return {
      name: "cerebras",
      apiKey: process.env.CEREBRAS_API_KEY,
      baseUrl: process.env.CEREBRAS_BASE_URL,
      model: process.env.CEREBRAS_MODEL,
    };
  }

  if (process.env.GEMINI_API_KEY) {
    return {
      name: "gemini",
      apiKey: process.env.GEMINI_API_KEY,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: process.env.SMITHERS_E2E_CHAT_MODEL ?? "gemini-2.5-flash",
    };
  }

  throw new Error(
    "Real chat e2e Worker requires CEREBRAS_API_KEY or GEMINI_API_KEY; refusing to boot without a real LLM upstream.",
  );
}

const provider = selectChatProvider();

const env: CloudflareEnv = {
  CEREBRAS_API_KEY: provider.apiKey,
  CEREBRAS_BASE_URL: provider.baseUrl,
  CEREBRAS_MODEL: provider.model,
  AUTH_API_BASE_URL: process.env.AUTH_API_BASE_URL,
  PLUE_API_BASE_URL: process.env.PLUE_API_BASE_URL,
  AUTH_CALLBACK_BASE_URL: process.env.AUTH_CALLBACK_BASE_URL,
  GATEWAY_BASE_URL: process.env.GATEWAY_BASE_URL,
  GATEWAY_AUTH_TOKEN: process.env.GATEWAY_AUTH_TOKEN,
  GO_API_BASE_URL: process.env.GO_API_BASE_URL,
  AUTH_REQUIRED: process.env.AUTH_REQUIRED,
  GATEWAY_TRUSTED_PROXY_SCOPES: process.env.GATEWAY_TRUSTED_PROXY_SCOPES,
  GATEWAY_TRUSTED_PROXY_ROLE: process.env.GATEWAY_TRUSTED_PROXY_ROLE,
};

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return worker.fetch(request, env);
  },
});

console.log(
  `[real-worker] listening on http://127.0.0.1:${server.port} using ${provider.name} model ${env.CEREBRAS_MODEL ?? "(default)"}`,
);
