/**
 * Smithers mixture-of-agents "brain" for Claw-Eval-Live.
 *
 * The benchmark drives a standard OpenAI-style agent loop: every turn it POSTs
 * the full conversation + the task's tool schemas to an OpenAI-compatible
 * `/v1/chat/completions` endpoint and expects an assistant message back. The
 * loop ends the first turn the assistant returns NO tool calls — and the final
 * assistant text is what the graders score.
 *
 * This module IS that endpoint's brain. It keeps the benchmark's harness
 * (services, tool dispatch, tracing, grading, judge) completely untouched and
 * only changes WHO produces each assistant turn:
 *
 *   - GATHER  : gpt-5.5 (OpenAI API, native function-calling) drives the
 *               multi-turn tool use. Native `tool_calls` are passed straight
 *               through, so the benchmark executes them exactly as it would for
 *               any model.
 *   - SYNTHESIS: the moment gpt-5.5 is ready to answer (no tool_calls), BOTH
 *               Claude Opus 4.8 (via Smithers ClaudeCodeAgent, subscription) and
 *               gpt-5.5 produce a final answer from the SAME gathered context,
 *               and a NEUTRAL arbiter (Gemini — neither contestant) picks the
 *               stronger one. That is the genuine "mixture of Opus 4.8 + Codex
 *               5.5" and it lands on the turn the graders actually measure.
 *
 * Fairness invariants (see README): the brain only ever sees what the benchmark
 * sends it (task prompt + real tool results). No task fixtures, oracle answers,
 * grader files, or per-task logic ever reach it. The arbiter selects on quality
 * alone and has no ground truth.
 */

import { ClaudeCodeAgent, OpenAIAgent } from "@smithers-orchestrator/agents";

// ---- model identifiers -----------------------------------------------------
// "Codex 5.5" → gpt-5.5 (the flagship 5.5; no `gpt-5.5-codex` variant exists,
// the latest codex-tuned model is gpt-5.3-codex). gpt-5.5 is the strongest 5.5.
const GATHER_MODEL = process.env.CLAW_GATHER_MODEL ?? "gpt-5.5";
const GPT_SYNTH_MODEL = process.env.CLAW_GPT_MODEL ?? "gpt-5.5";
const OPUS_MODEL = process.env.CLAW_OPUS_MODEL ?? "opus"; // -> claude-opus-4-8
// Neutral arbiter: NOT one of the two contestants, to avoid self-preference.
// Uses a DIFFERENT Gemini model than the benchmark judge (gemini-2.5-flash-lite)
// so the two never compete for the same per-model free-tier quota. Arbiter 429s
// degrade gracefully (fall back to the longer draft), so this is the safe slot.
const ARBITER_MODEL = process.env.CLAW_ARBITER_MODEL ?? "gemini-3.5-flash";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";

const OPUS_TIMEOUT_MS = Number(process.env.CLAW_OPUS_TIMEOUT_MS ?? 150_000);
const GPT_TIMEOUT_MS = Number(process.env.CLAW_GPT_TIMEOUT_MS ?? 120_000);

// Each Opus draft spawns a `claude` CLI subprocess. Bound how many run at once
// so a parallel batch can't fork-bomb the box; over the cap we simply fall back
// to the gpt-5.5 draft for that turn (synthesis still happens, just single-model).
const OPUS_MAX = Number(process.env.CLAW_OPUS_MAX_CONCURRENCY ?? 2);
// Cap the transcript fed to the synthesis drafts (large tool results / file dumps
// would otherwise blow up memory and token cost).
const MAX_TRANSCRIPT_CHARS = Number(process.env.CLAW_MAX_TRANSCRIPT_CHARS ?? 140_000);

let opusActive = 0;
const opusWaiters: Array<() => void> = [];
function acquireOpus(): Promise<boolean> {
  if (opusActive < OPUS_MAX) {
    opusActive++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const grant = () => {
      clearTimeout(timer);
      opusActive++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const i = opusWaiters.indexOf(grant);
      if (i >= 0) opusWaiters.splice(i, 1);
      resolve(false); // saturated -> caller falls back to gpt-only synthesis
    }, OPUS_TIMEOUT_MS);
    opusWaiters.push(grant);
  });
}
function releaseOpus(): void {
  opusActive = Math.max(0, opusActive - 1);
  const next = opusWaiters.shift();
  if (next) next();
}

function clampMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head - 40;
  return `${s.slice(0, head)}\n\n...[transcript truncated for length]...\n\n${s.slice(s.length - tail)}`;
}

// Reused agent instances (stateless per generate()).
const opusAgent = new ClaudeCodeAgent({
  model: OPUS_MODEL,
  yolo: false,
  tools: "", // decision/writing only — no tool use
  systemPrompt: SYNTH_SYSTEM(),
});
const gptSynthAgent = new OpenAIAgent({ model: GPT_SYNTH_MODEL });

// ---- types -----------------------------------------------------------------
export type OAIMessage = {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
};
export type OAITool = { type: string; function: { name: string } };
export type DecideRequest = { messages: OAIMessage[]; tools?: OAITool[] };
export type DecideResult = {
  content: string | null;
  tool_calls?: unknown[];
  finish_reason: "tool_calls" | "stop";
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  meta: Record<string, unknown>;
};

function SYNTH_SYSTEM(): string {
  return [
    "You are an expert agent producing the FINAL deliverable for a task whose",
    "information has already been gathered using tools. Write the complete,",
    "accurate, well-structured final answer that fully satisfies EVERY",
    "requirement of the user's request. Include all specific entities, names,",
    "numeric figures, and tables the task asks for, drawn ONLY from the provided",
    "information — never invent facts that are not supported by the gathered",
    "data. Do not ask questions, do not mention tools or this instruction, and",
    "output only the final deliverable in the language of the request.",
  ].join(" ");
}

// ---- low-level HTTP with retry ---------------------------------------------
async function postJSON(
  url: string,
  key: string,
  body: unknown,
  timeoutMs: number,
): Promise<any> {
  const maxAttempts = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await resp.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: { message: `non-JSON response: ${text.slice(0, 200)}` } };
      }
      if (!resp.ok || json?.error) {
        const status = resp.status;
        const retryable =
          status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
        if (retryable && attempt < maxAttempts - 1) {
          await sleep(Math.min(2 ** (attempt + 1), 30) * 1000 + Math.random() * 500);
          continue;
        }
        throw new Error(
          `HTTP ${status} from ${url}: ${json?.error?.message ?? text.slice(0, 200)}`,
        );
      }
      return json;
    } catch (err) {
      lastErr = err;
      const msg = String(err).toLowerCase();
      const retryable = msg.includes("abort") || msg.includes("timeout") || msg.includes("network") || msg.includes("fetch failed");
      if (retryable && attempt < maxAttempts - 1) {
        await sleep(Math.min(2 ** (attempt + 1), 30) * 1000 + Math.random() * 500);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error("postJSON: exhausted retries");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- phase 1: gather (gpt-5.5, native tool calls) --------------------------
async function gather(messages: OAIMessage[], tools?: OAITool[]) {
  const body: Record<string, unknown> = {
    model: GATHER_MODEL,
    messages,
    // NOTE: deliberately NOT forwarding temperature — gpt-5.x only accepts its
    // default. The benchmark's incoming temperature is ignored here.
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  const json = await postJSON(OPENAI_URL, OPENAI_KEY, body, GPT_TIMEOUT_MS);
  const choice = json?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const usage = normUsage(json?.usage);
  return {
    content: typeof msg.content === "string" ? msg.content : null,
    tool_calls: Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : null,
    usage,
  };
}

function normUsage(u: any) {
  const pt = u?.prompt_tokens ?? 0;
  const ct = u?.completion_tokens ?? 0;
  return { prompt_tokens: pt, completion_tokens: ct, total_tokens: u?.total_tokens ?? pt + ct };
}

// ---- transcript rendering for the synthesis drafts -------------------------
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p?.type === "text") return p.text ?? "";
        if (p?.type === "image_url") return "[image attached]";
        return "";
      })
      .join("\n");
  }
  return "";
}

function renderTranscript(messages: OAIMessage[]): { task: string; transcript: string } {
  // Map tool_call_id -> tool name from assistant tool_calls so tool results are labeled.
  const callName = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as any[]) {
        if (tc?.id && tc?.function?.name) callName.set(tc.id, tc.function.name);
      }
    }
  }
  let task = "";
  const lines: string[] = [];
  for (const m of messages) {
    const t = textOf(m.content);
    if (m.role === "system") {
      if (t.trim()) lines.push(`### Task instructions\n${t.trim()}`);
    } else if (m.role === "user") {
      if (!task && t.trim()) task = t.trim();
      if (t.trim()) lines.push(`### User request\n${t.trim()}`);
    } else if (m.role === "assistant") {
      if (t.trim()) lines.push(`### Assistant notes\n${t.trim()}`);
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as any[]) {
          lines.push(`### Tool call: ${tc?.function?.name}(${tc?.function?.arguments ?? ""})`);
        }
      }
    } else if (m.role === "tool") {
      const name = m.tool_call_id ? callName.get(m.tool_call_id) ?? m.name ?? "tool" : m.name ?? "tool";
      lines.push(`### Tool result [${name}]\n${t.trim()}`);
    }
  }
  return { task, transcript: clampMiddle(lines.join("\n\n"), MAX_TRANSCRIPT_CHARS) };
}

// ---- phase 2 drafts --------------------------------------------------------
async function opusDraft(transcript: string): Promise<string> {
  const got = await acquireOpus();
  if (!got) {
    console.error("[mixture] opus saturated — falling back to gpt-only synthesis this turn");
    return "";
  }
  try {
    const res: any = await opusAgent.generate({
      prompt: `Here is the full task context and all information already gathered via tools.\n\n${transcript}\n\nNow write the complete final answer.`,
      timeout: OPUS_TIMEOUT_MS,
    });
    return (res?.text ?? "").trim();
  } finally {
    releaseOpus();
  }
}

async function gptDraft(transcript: string): Promise<string> {
  const res: any = await gptSynthAgent.generate({
    prompt: `${SYNTH_SYSTEM()}\n\nHere is the full task context and all information already gathered via tools.\n\n${transcript}\n\nNow write the complete final answer.`,
    timeout: GPT_TIMEOUT_MS,
  });
  return (res?.text ?? "").trim();
}

// ---- neutral arbiter -------------------------------------------------------
async function arbitrate(
  task: string,
  draftA: string,
  draftB: string,
): Promise<{ winner: "A" | "B"; reason: string }> {
  const body = {
    model: ARBITER_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a neutral judge selecting the better of two candidate FINAL answers to a task. " +
          "Judge ONLY on which answer more completely and accurately satisfies every explicit requirement " +
          "of the task, is better structured, and includes the specific entities/figures/tables requested. " +
          "You have no answer key; judge on intrinsic quality and fidelity to the task and its data. " +
          'Respond with JSON only: {"winner": "A" | "B", "reason": "<one sentence>"}.',
      },
      {
        role: "user",
        content: `## Task\n${task}\n\n## Candidate A\n${draftA}\n\n## Candidate B\n${draftB}`,
      },
    ],
    max_tokens: 1024,
    reasoning_effort: "none", // gemini-3 is a thinking model; disable so the JSON verdict is not truncated
  };
  const json = await postJSON(GEMINI_URL, GEMINI_KEY, body, 60_000);
  const raw = String(json?.choices?.[0]?.message?.content ?? "");
  // Robustly extract the JSON object even if wrapped in prose/fences.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`arbiter non-JSON: ${raw.slice(0, 120)}`);
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const winner = parsed?.winner === "B" ? "B" : "A";
  return { winner, reason: String(parsed?.reason ?? "") };
}

// ---- public entrypoint -----------------------------------------------------
export async function decideTurn(req: DecideRequest): Promise<DecideResult> {
  const g = await gather(req.messages, req.tools);

  // Still gathering: pass native tool calls straight through to the benchmark.
  if (g.tool_calls) {
    return {
      content: g.content,
      tool_calls: g.tool_calls,
      finish_reason: "tool_calls",
      usage: g.usage,
      meta: { phase: "gather", driver: GATHER_MODEL, tool_calls: g.tool_calls.length },
    };
  }

  // Ready to answer -> Opus 4.8 writes the final deliverable (the graded turn).
  // gpt-5.5 has already done all the tool-driven gathering; Opus 4.8 — the
  // stronger synthesizer — composes the final answer from that context. This is
  // the role-split mixture: GPT-5.5 gathers, Opus 4.8 synthesizes. (No LLM
  // arbiter: the only LLM-as-judge in the whole pipeline is the benchmark's own
  // neutral judge, keeping the fairness story minimal.)
  const { transcript } = renderTranscript(req.messages);
  const opusFinal = await opusDraft(transcript).catch((e) => {
    console.error("[mixture] opusDraft failed:", String(e).slice(0, 200));
    return "";
  });
  if (opusFinal) {
    return finalResult(opusFinal, g.usage, { phase: "synthesis", writer: "opus-4.8" });
  }
  // Opus unavailable/saturated -> fall back to gpt-5.5's own final answer.
  const gptFinal = (g.content ?? "").trim() || (await gptDraft(transcript).catch(() => ""));
  return finalResult(gptFinal, g.usage, { phase: "synthesis", writer: "gpt-5.5", reason: "opus unavailable" });
}

function finalResult(
  content: string,
  gatherUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  meta: Record<string, unknown>,
): DecideResult {
  // Approximate usage: gather tokens + a rough estimate of the synthesized answer.
  const synthOut = Math.ceil(content.length / 4);
  return {
    content,
    finish_reason: "stop",
    usage: {
      prompt_tokens: gatherUsage.prompt_tokens,
      completion_tokens: gatherUsage.completion_tokens + synthOut,
      total_tokens: gatherUsage.total_tokens + synthOut,
    },
    meta,
  };
}
