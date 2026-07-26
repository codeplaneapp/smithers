/**
 * scriptedAgent — in-process AgentLike driven by an AgentTraceVector.
 * Uses a virtual clock for delays; emits onStdout text chunks for stream fidelity.
 */

import type { FakeAgent, FakeAgentCall, FakeAgentFiles, FakeAgentResult, SafeSchema } from "./fakeAgent.ts";
import { type AgentTraceVector, flattenGeneratePrompt, selectTurn } from "./agentTraceVector.ts";
import { type VirtualClock, createVirtualClock } from "./virtualClock.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type ScriptedAgentPacing = {
  /** Inclusive min wall/virtual delay before playing the turn stream (ms). */
  minMs: number;
  /** Inclusive max delay (ms). Random uniform in [minMs, maxMs]. */
  maxMs: number;
};

export type ScriptedAgentOptions = {
  id?: string;
  model?: string;
  clock?: VirtualClock;
  /** Optional schema to validate ok.output (like fakeAgent). */
  schema?: SafeSchema<unknown>;
  supportsNativeStructuredOutput?: boolean;
  /**
   * Extra per-generate pacing so human herdr watch can see "working" and
   * streaming overview updates. Typical human watch: { minMs: 2000, maxMs: 5000 }
   * with a real wall clock.
   */
  pacing?: ScriptedAgentPacing;
};

export type ScriptedAgent = FakeAgent<unknown> & {
  readonly vector: AgentTraceVector;
  readonly clock: VirtualClock;
  /** Indices of turns already consumed. */
  readonly usedTurnIndexes: ReadonlySet<number>;
};

function assertSafeRelativePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
    throw new TypeError(`Scripted agent file path must stay inside rootDir: ${path}`);
  }
}

async function writeFiles(rootDir: string | undefined, files: FakeAgentFiles | undefined): Promise<void> {
  if (!files || Object.keys(files).length === 0) return;
  if (!rootDir) {
    throw new TypeError("Scripted agent files require a rootDir");
  }
  const root = resolve(rootDir);
  for (const [name, contents] of Object.entries(files)) {
    assertSafeRelativePath(name);
    const target = resolve(root, name);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new TypeError(`Scripted agent file path must stay inside rootDir: ${name}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

/**
 * Build an AgentLike that plays {@link AgentTraceVector} turns in order
 * (with optional when-matching for steers / retries).
 */
export function scriptedAgent(vector: AgentTraceVector, options: ScriptedAgentOptions = {}): ScriptedAgent {
  const clock = options.clock ?? createVirtualClock();
  const calls: FakeAgentCall[] = [];
  const used = new Set<number>();
  let callIndex = 0;

  const agent: ScriptedAgent = {
    id: options.id ?? `scripted:${vector.id}`,
    model: options.model ?? "scripted-agent",
    tools: {},
    supportsNativeStructuredOutput: options.supportsNativeStructuredOutput ?? true,
    calls,
    vector,
    clock,
    get usedTurnIndexes() {
      return used;
    },
    async generate(args = {}) {
      const rootDir = typeof args.rootDir === "string" ? args.rootDir : undefined;
      const taskContext =
        args.taskContext && typeof args.taskContext === "object"
          ? (args.taskContext as Record<string, unknown>)
          : undefined;
      const attempt =
        typeof taskContext?.attempt === "number"
          ? taskContext.attempt
          : typeof args.retryAttempt === "number"
            ? (args.retryAttempt as number)
            : undefined;
      const iteration = typeof taskContext?.iteration === "number" ? taskContext.iteration : undefined;
      const promptText = flattenGeneratePrompt(args);

      const call: FakeAgentCall = {
        args,
        prompt: args.prompt,
        rootDir,
        taskContext,
      };
      calls.push(call);

      const { index, turn } = selectTurn(vector, used, {
        callIndex,
        attempt,
        iteration,
        promptText,
      });
      used.add(index);
      callIndex += 1;

      // Play stream events (virtual delays + stdout text).
      const onStdout = typeof args.onStdout === "function" ? (args.onStdout as (t: string) => void) : undefined;
      const onEvent = typeof args.onEvent === "function" ? (args.onEvent as (e: unknown) => void) : undefined;

      // Human-watch / live-tail pacing: think time before tokens so herdr
      // overview shows "working" and node panes get stream chunks slowly.
      if (options.pacing) {
        const lo = Math.max(0, options.pacing.minMs);
        const hi = Math.max(lo, options.pacing.maxMs);
        const thinkMs = lo + Math.floor(Math.random() * (hi - lo + 1));
        onStdout?.(`[scripted] thinking ${thinkMs}ms…\n`);
        await clock.advance(thinkMs);
      }

      if (Array.isArray(turn.stream)) {
        for (const ev of turn.stream) {
          if (ev.t === "delay") {
            await clock.advance(ev.ms);
          } else if (ev.t === "text") {
            onStdout?.(ev.text);
            onEvent?.({ type: "text", text: ev.text });
            // Small inter-token gap in real mode so panes feel alive
            if (clock.mode === "real" && options.pacing) {
              await clock.advance(80 + Math.floor(Math.random() * 120));
            }
          } else if (ev.t === "tool_start") {
            onEvent?.({ type: "tool_start", name: ev.name, input: ev.input });
            onStdout?.(`[tool_start ${ev.name}]\n`);
          } else if (ev.t === "tool_end") {
            onEvent?.({ type: "tool_end", name: ev.name, output: ev.output });
            onStdout?.(`[tool_end ${ev.name}]\n`);
          } else if (ev.t === "progress") {
            onEvent?.({ type: "progress", message: ev.message });
            onStdout?.(`${ev.message}\n`);
          }
        }
      }

      const result = turn.result;
      if (result.kind === "hang") {
        const ms = result.ms ?? 60_000;
        // Advance simulated time, then fail as a non-cancel timeout so the
        // engine records a failed node (not AbortError → cancelled).
        // Real wall hang: only in clock.mode === "real" (opt-in).
        if (clock.mode === "real") {
          const signal = args.abortSignal as AbortSignal | undefined;
          await Promise.race([
            clock.advance(ms),
            signal
              ? new Promise<never>((_, reject) => {
                  const onAbort = () => {
                    const err = new Error("Scripted agent aborted during hang");
                    (err as { name?: string }).name = "AbortError";
                    reject(err);
                  };
                  if (signal.aborted) onAbort();
                  else signal.addEventListener("abort", onAbort, { once: true });
                })
              : new Promise<void>(() => {}),
          ]);
        } else {
          await clock.advance(ms);
        }
        throw Object.assign(new Error(`Scripted agent hang after ${ms}ms (vector ${vector.id})`), {
          code: "AGENT_TIMEOUT",
          details: { failureRetryable: false },
        });
      }
      if (result.kind === "fail") {
        // Engine reads details.failureRetryable === false to skip retries.
        const err = Object.assign(new Error(result.error), {
          code: result.retryable === false ? "AGENT_SCRIPT_FAIL" : "AGENT_SCRIPT_FAIL_RETRYABLE",
          details: { failureRetryable: result.retryable === true ? undefined : false },
        });
        if (result.retryable === true) {
          // Leave failureRetryable unset so default retry policy applies.
          delete (err as { details?: { failureRetryable?: boolean } }).details!.failureRetryable;
        }
        throw err;
      }

      // ok
      let output = result.output;
      if (options.schema && output !== undefined) {
        const parsed = options.schema.safeParse(output);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((issue) =>
              issue && typeof issue === "object" && "message" in issue
                ? String((issue as { message: unknown }).message)
                : JSON.stringify(issue),
            )
            .join("; ");
          throw new TypeError(`Scripted agent output failed validation: ${issues}`);
        }
        output = parsed.data;
      }
      await writeFiles(rootDir, result.files);

      const generated: FakeAgentResult<unknown> = {};
      if (output !== undefined) generated.output = output;
      if (typeof result.text === "string") generated.text = result.text;
      // Engine often expects response.messages for conversation capture
      generated.text =
        generated.text ??
        (typeof output === "object" && output !== null
          ? JSON.stringify(output)
          : typeof output === "string"
            ? output
            : `scripted:${vector.id}`);
      return {
        ...generated,
        response: {
          messages: [{ role: "assistant", content: generated.text }],
        },
      } as FakeAgentResult<unknown>;
    },
    lastPrompt() {
      return calls.at(-1)?.prompt;
    },
    reset() {
      calls.length = 0;
      used.clear();
      callIndex = 0;
    },
  };

  return agent;
}
