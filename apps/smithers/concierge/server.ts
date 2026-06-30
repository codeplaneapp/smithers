/**
 * The local concierge server.
 *
 * This is the heart of the chat-first UI: you talk to a concierge agent and it
 * aggressively backgrounds Smithers workflows on the local gateway. It serves
 * `POST /api/chat` as a Server-Sent Events stream in the exact shape the app's
 * `streamReplyViaApi` expects (`{type:"TEXT_MESSAGE_CONTENT",delta}` frames then
 * `[DONE]`).
 *
 * Two modes, picked at request time:
 *   - LLM (when `ANTHROPIC_API_KEY` is set): a real agent with a `launch_workflow`
 *     tool that calls the gateway's `launchRun` RPC, plus `list_workflows` /
 *     `list_runs`. The system prompt tells it to background work eagerly.
 *   - Heuristic (no key, or the LLM call fails): classifies the message, launches
 *     the best-matching registered workflow, and narrates what it backgrounded.
 *     Zero external calls beyond the gateway, so the chat always works locally.
 */
const PORT = Number(process.env.SMITHERS_CONCIERGE_PORT ?? "5179");
const HOST = process.env.SMITHERS_CONCIERGE_HOST ?? "127.0.0.1";
const GATEWAY = (process.env.SMITHERS_GATEWAY_PROXY_TARGET ?? "http://127.0.0.1:7331").replace(
  /\/+$/,
  "",
);

type ChatMessage = { role: "user" | "assistant"; content: string };

async function gatewayRpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${GATEWAY}/v1/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const frame = (await res.json()) as { ok?: boolean; payload?: unknown; error?: { message?: string } };
  if (!frame.ok) throw new Error(frame.error?.message ?? `gateway ${method} failed`);
  return frame.payload;
}

type WorkflowSummary = { key: string; readableName?: string; description?: string };

async function listWorkflows(): Promise<WorkflowSummary[]> {
  try {
    const rows = (await gatewayRpc("listWorkflows", {})) as WorkflowSummary[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function launchWorkflow(workflow: string, prompt: string): Promise<string | null> {
  try {
    const payload = (await gatewayRpc("launchRun", {
      workflow,
      input: { prompt },
    })) as { runId?: string };
    return payload?.runId ?? null;
  } catch {
    return null;
  }
}

/** Pick the workflow whose key/intent best matches the request. */
function classify(message: string, workflows: WorkflowSummary[]): { workflow: string; launch: boolean } {
  const text = message.toLowerCase().trim();
  const has = (key: string) => workflows.some((w) => w.key === key);
  // Prefer a candidate that's actually registered; otherwise fall back to the
  // first registered workflow so the concierge always backgrounds *something*.
  const pick = (...candidates: string[]) =>
    candidates.find(has) ?? workflows[0]?.key ?? candidates[0];

  // Conversational / questions: answer, do not launch.
  if (/^(hi|hey|hello|yo|thanks|thank you|ok|cool|nice)\b/.test(text)) {
    return { workflow: "", launch: false };
  }
  if (/^(what|who|why|how|when|where|can you|do you|is there|are there)\b/.test(text) || text.endsWith("?")) {
    return { workflow: "", launch: false };
  }

  if (/\b(fix|debug|broken|error|bug|failing|crash)\b/.test(text)) return { workflow: pick("debug", "implement"), launch: true };
  if (/\b(review|audit|check)\b/.test(text)) return { workflow: pick("review", "audit", "implement"), launch: true };
  if (/\b(research|investigate|explore|find out|look into)\b/.test(text)) return { workflow: pick("research", "implement"), launch: true };
  if (/\b(test|coverage|spec)\b/.test(text)) return { workflow: pick("improve-test-coverage", "implement"), launch: true };
  if (/\b(plan|design|spec out|figure out)\b/.test(text)) return { workflow: pick("plan", "research", "implement"), launch: true };
  // Default: a build/implement request — background it.
  return { workflow: pick("implement"), launch: true };
}

function sseFrame(delta: string): string {
  return `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta })}\n\n`;
}

/** Stream a heuristic concierge reply: classify, launch, narrate. */
async function* heuristicReply(messages: ChatMessage[]): AsyncGenerator<string> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const workflows = await listWorkflows();
  const { workflow, launch } = classify(lastUser, workflows);

  if (!launch || !workflow) {
    yield "I'm your Smithers concierge. Tell me what to build, fix, review, or research and I'll background a workflow for it. ";
    if (workflows.length) {
      yield `Right now your gateway has: ${workflows.map((w) => `\`${w.key}\``).slice(0, 8).join(", ")}.`;
    } else {
      yield "Your gateway has no workflows registered yet.";
    }
    return;
  }

  yield `On it — backgrounding a \`${workflow}\` run`;
  const runId = await launchWorkflow(workflow, lastUser);
  if (runId) {
    yield ` for that.\n\nRun \`${runId.slice(0, 8)}\` is live; track it in **Runs**. I'll keep going while it works.`;
  } else {
    yield `…\n\nbut the gateway couldn't start it (is \`${workflow}\` registered, and is the gateway up?).`;
  }
}

/** Stream an LLM concierge reply with a launch_workflow tool. Best-effort. */
async function* llmReply(messages: ChatMessage[], system: string | undefined): AsyncGenerator<string> {
  const { streamText, tool } = await import("ai");
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const { z } = await import("zod");
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = anthropic(process.env.SMITHERS_CONCIERGE_MODEL ?? "claude-sonnet-4-5");

  const workflows = await listWorkflows();
  const baseSystem =
    "You are the Smithers concierge inside a local control plane. You chat with the user and AGGRESSIVELY background Smithers workflows on their behalf: whenever a request implies real work (build, fix, debug, review, research, test), call launch_workflow immediately rather than asking for confirmation, then tell the user what you backgrounded and that they can track it in Runs. Keep replies short. " +
    (workflows.length
      ? `Registered workflows: ${workflows.map((w) => w.key).join(", ")}. Prefer "implement" for build requests.`
      : "No workflows are registered yet.");

  const result = streamText({
    model,
    system: system ? `${baseSystem}\n\n${system}` : baseSystem,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stopWhen: undefined,
    tools: {
      launch_workflow: tool({
        description: "Background a Smithers workflow run on the gateway. Use eagerly for any real task.",
        inputSchema: z.object({
          workflow: z.string().describe("The workflow key to launch, e.g. implement, debug, review, research."),
          prompt: z.string().describe("The task/prompt for the run."),
        }),
        execute: async ({ workflow, prompt }: { workflow: string; prompt: string }) => {
          const runId = await launchWorkflow(workflow, prompt);
          return runId ? { runId, status: "launched" } : { error: "launch failed" };
        },
      }),
      list_workflows: tool({
        description: "List the workflows registered on the gateway.",
        inputSchema: z.object({}),
        execute: async () => ({ workflows: (await listWorkflows()).map((w) => w.key) }),
      }),
    },
  });

  for await (const delta of result.textStream) {
    yield delta;
  }
}

async function handleChat(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { messages?: ChatMessage[]; system?: string };
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (chunk: string) => controller.enqueue(enc.encode(chunk));
      try {
        const useLlm = Boolean(process.env.ANTHROPIC_API_KEY);
        let sent = 0;
        if (useLlm) {
          try {
            for await (const delta of llmReply(messages, body.system)) {
              sent += 1;
              send(sseFrame(delta));
            }
          } catch {
            // LLM path failed (no creds/credits/network). Only fall back if it
            // produced nothing, so we never double up a partial reply.
            sent = sent > 0 ? sent : -1;
          }
        }
        if (!useLlm || sent === -1) {
          for await (const delta of heuristicReply(messages)) send(sseFrame(delta));
        }
      } catch (err) {
        send(`data: ${JSON.stringify({ type: "RUN_ERROR", message: String(err) })}\n\n`);
      }
      send("data: [DONE]\n\n");
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && (url.pathname === "/api/chat" || url.pathname === "/api/ask")) {
      return handleChat(req);
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  },
});

console.log(`[concierge] listening on http://${HOST}:${PORT} (gateway ${GATEWAY})`);
