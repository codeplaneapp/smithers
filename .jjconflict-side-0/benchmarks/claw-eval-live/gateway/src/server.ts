/**
 * OpenAI-compatible HTTP gateway backed by the Smithers mixture brain.
 *
 * Claw-Eval-Live's `OpenAICompatProvider` talks to this server exactly as it
 * would to OpenAI / OpenRouter. We expose the two endpoints it needs:
 *   - GET  /v1/models             (discovery)
 *   - POST /v1/chat/completions   (one assistant turn per call)
 * plus GET /health for readiness probes.
 *
 * The benchmark's grading, services, tool dispatch and tracing are entirely
 * unaffected — this server only decides the content of each assistant turn.
 */

// Bun caps idleTimeout at 255s, and a turn is idle on the socket for its whole
// gather+synthesis duration (the response is only written after both phases
// finish). mixture.ts reads its per-phase budgets from CLAW_GPT_TIMEOUT_MS +
// CLAW_FABLE_TIMEOUT_MS at module load, and their defaults (120s + 150s = 270s)
// exceed that ceiling, so a slow synthesis turn would be killed by Bun before
// it could respond. Clamp the sum to fit under idleTimeout (with margin) BEFORE
// importing mixture.ts so the per-phase timeouts become the real constraint.
const IDLE_TIMEOUT_S = 255; // Bun's documented maximum.
const PHASE_BUDGET_MS = (IDLE_TIMEOUT_S - 5) * 1000; // leave headroom for I/O.
{
  const fable = Number(process.env.CLAW_FABLE_TIMEOUT_MS ?? 150_000);
  const gpt = Number(process.env.CLAW_GPT_TIMEOUT_MS ?? 120_000);
  if (fable + gpt > PHASE_BUDGET_MS) {
    const scale = PHASE_BUDGET_MS / (fable + gpt);
    process.env.CLAW_GPT_TIMEOUT_MS = String(Math.floor(gpt * scale));
    process.env.CLAW_FABLE_TIMEOUT_MS = String(Math.floor(fable * scale));
    console.warn(
      `[gateway] gather+synthesis budget ${fable + gpt}ms exceeds idle ceiling; ` +
        `clamped to CLAW_GPT_TIMEOUT_MS=${process.env.CLAW_GPT_TIMEOUT_MS} ` +
        `CLAW_FABLE_TIMEOUT_MS=${process.env.CLAW_FABLE_TIMEOUT_MS}`,
    );
  }
}

const { decideTurn } = await import("./mixture.ts");
import type { OAIMessage, OAITool } from "./mixture.ts";

// A single bad turn (provider hiccup, CLI subprocess error) must never take the
// whole gateway down mid-batch — log and keep serving. The benchmark retries
// connection/5xx errors on its side, so transient turns self-heal.
process.on("uncaughtException", (err) => console.error("[gateway] uncaughtException:", err));
process.on("unhandledRejection", (reason) => console.error("[gateway] unhandledRejection:", reason));

const PORT = Number(process.env.CLAW_GATEWAY_PORT ?? 8788);
const MODEL_ID = process.env.CLAW_MODEL_ID ?? "smithers-mixture-fable5-gpt55";

function requireEnv() {
  const missing: string[] = [];
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!process.env.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  if (missing.length) {
    console.error(`[gateway] FATAL: missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}
requireEnv();

let nReq = 0;

function chatResponse(decision: Awaited<ReturnType<typeof decideTurn>>) {
  const message: Record<string, unknown> = { role: "assistant", content: decision.content };
  if (decision.tool_calls && decision.tool_calls.length) {
    message.tool_calls = decision.tool_calls;
  }
  return {
    id: `chatcmpl-smithers-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{ index: 0, message, finish_reason: decision.finish_reason, logprobs: null }],
    usage: {
      prompt_tokens: decision.usage.prompt_tokens,
      completion_tokens: decision.usage.completion_tokens,
      total_tokens: decision.usage.total_tokens,
    },
    smithers_meta: decision.meta,
  };
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: IDLE_TIMEOUT_S, // Bun's max; gather+synthesis budgets are clamped to fit under it.
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, model: MODEL_ID });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "smithers" }],
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const id = ++nReq;
      const t0 = Date.now();
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: { message: "invalid JSON body" } }, { status: 400 });
      }
      const messages: OAIMessage[] = Array.isArray(body?.messages) ? body.messages : [];
      const tools: OAITool[] | undefined = Array.isArray(body?.tools) ? body.tools : undefined;
      try {
        const decision = await decideTurn({ messages, tools });
        const dt = Date.now() - t0;
        const tag =
          decision.finish_reason === "tool_calls"
            ? `gather (${(decision.meta as any).tool_calls} tool_calls)`
            : `synthesis writer=${(decision.meta as any).writer}`;
        console.log(`[req ${id}] ${tag} in ${dt}ms`);
        return Response.json(chatResponse(decision));
      } catch (err) {
        console.error(`[req ${id}] ERROR after ${Date.now() - t0}ms:`, String(err).slice(0, 400));
        return Response.json(
          { error: { message: String(err).slice(0, 500), type: "smithers_gateway_error" } },
          { status: 502 },
        );
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`[gateway] Smithers mixture brain listening on http://127.0.0.1:${server.port}`);
console.log(`[gateway] model_id=${MODEL_ID}`);
console.log(`[gateway] gather=${process.env.CLAW_GATHER_MODEL ?? "gpt-5.5"} fable=${process.env.CLAW_FABLE_MODEL ?? "claude-fable-5"} arbiter=${process.env.CLAW_ARBITER_MODEL ?? "gemini-3.5-flash"}`);
