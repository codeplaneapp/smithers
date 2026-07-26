// src/agentTraceVector.ts
import { readFileSync } from "fs";
import { extname } from "path";
function flattenGeneratePrompt(args) {
  if (!args) return "";
  if (typeof args.prompt === "string") return args.prompt;
  if (Array.isArray(args.messages)) {
    return args.messages.map((m) => {
      if (!m || typeof m !== "object") return "";
      const c = m.content;
      return typeof c === "string" ? c : JSON.stringify(c ?? "");
    }).join("\n");
  }
  if (args.prompt != null) return JSON.stringify(args.prompt);
  return "";
}
function selectTurn(vector, used, ctx) {
  for (let i = 0; i < vector.turns.length; i++) {
    if (used.has(i)) continue;
    const turn = vector.turns[i];
    const w = turn.when;
    if (!w) continue;
    if (w.callIndex !== void 0 && w.callIndex !== ctx.callIndex) continue;
    if (w.attempt !== void 0 && w.attempt !== ctx.attempt) continue;
    if (w.iteration !== void 0 && w.iteration !== ctx.iteration) continue;
    if (w.promptIncludes !== void 0 && !ctx.promptText.includes(w.promptIncludes)) continue;
    return { index: i, turn };
  }
  for (let i = 0; i < vector.turns.length; i++) {
    if (used.has(i)) continue;
    const turn = vector.turns[i];
    if (turn.when && Object.keys(turn.when).length > 0) continue;
    return { index: i, turn };
  }
  throw new Error(
    `Agent trace vector "${vector.id}": no matching unused turn for callIndex=${ctx.callIndex}` + (ctx.attempt !== void 0 ? ` attempt=${ctx.attempt}` : "") + (ctx.iteration !== void 0 ? ` iteration=${ctx.iteration}` : "") + (ctx.promptText ? ` promptExcerpt=${JSON.stringify(ctx.promptText.slice(0, 80))}` : "")
  );
}

// src/virtualClock.ts
function createVirtualClock(options = {}) {
  const mode = options.mode === "real" ? "real" : "virtual";
  let current = typeof options.startMs === "number" && Number.isFinite(options.startMs) ? options.startMs : 0;
  async function advance(ms) {
    const n = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (mode === "real") {
      if (n > 0) {
        await new Promise((r) => setTimeout(r, n));
      }
      return;
    }
    current += n;
  }
  return {
    mode,
    now() {
      return mode === "real" ? Date.now() : current;
    },
    advance,
    sleep: advance,
    setNow(ms) {
      if (mode === "virtual" && typeof ms === "number" && Number.isFinite(ms)) {
        current = ms;
      }
    }
  };
}

// src/scriptedAgent.ts
import { mkdir, writeFile } from "fs/promises";
import { dirname, isAbsolute, relative, resolve } from "path";
function assertSafeRelativePath(path) {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
    throw new TypeError(`Scripted agent file path must stay inside rootDir: ${path}`);
  }
}
async function writeFiles(rootDir, files) {
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
function scriptedAgent(vector, options = {}) {
  const clock = options.clock ?? createVirtualClock();
  const calls = [];
  const used = /* @__PURE__ */ new Set();
  let callIndex = 0;
  const agent = {
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
      const rootDir = typeof args.rootDir === "string" ? args.rootDir : void 0;
      const taskContext = args.taskContext && typeof args.taskContext === "object" ? args.taskContext : void 0;
      const attempt = typeof taskContext?.attempt === "number" ? taskContext.attempt : typeof args.retryAttempt === "number" ? args.retryAttempt : void 0;
      const iteration = typeof taskContext?.iteration === "number" ? taskContext.iteration : void 0;
      const promptText = flattenGeneratePrompt(args);
      const call = {
        args,
        prompt: args.prompt,
        rootDir,
        taskContext
      };
      calls.push(call);
      const { index, turn } = selectTurn(vector, used, {
        callIndex,
        attempt,
        iteration,
        promptText
      });
      used.add(index);
      callIndex += 1;
      const onStdout = typeof args.onStdout === "function" ? args.onStdout : void 0;
      const onEvent = typeof args.onEvent === "function" ? args.onEvent : void 0;
      if (options.pacing) {
        const lo = Math.max(0, options.pacing.minMs);
        const hi = Math.max(lo, options.pacing.maxMs);
        const thinkMs = lo + Math.floor(Math.random() * (hi - lo + 1));
        onStdout?.(`[scripted] thinking ${thinkMs}ms\u2026
`);
        await clock.advance(thinkMs);
      }
      if (Array.isArray(turn.stream)) {
        for (const ev of turn.stream) {
          if (ev.t === "delay") {
            await clock.advance(ev.ms);
          } else if (ev.t === "text") {
            onStdout?.(ev.text);
            onEvent?.({ type: "text", text: ev.text });
            if (clock.mode === "real" && options.pacing) {
              await clock.advance(80 + Math.floor(Math.random() * 120));
            }
          } else if (ev.t === "tool_start") {
            onEvent?.({ type: "tool_start", name: ev.name, input: ev.input });
            onStdout?.(`[tool_start ${ev.name}]
`);
          } else if (ev.t === "tool_end") {
            onEvent?.({ type: "tool_end", name: ev.name, output: ev.output });
            onStdout?.(`[tool_end ${ev.name}]
`);
          } else if (ev.t === "progress") {
            onEvent?.({ type: "progress", message: ev.message });
            onStdout?.(`${ev.message}
`);
          }
        }
      }
      const result = turn.result;
      if (result.kind === "hang") {
        const ms = result.ms ?? 6e4;
        if (clock.mode === "real") {
          const signal = args.abortSignal;
          await Promise.race([
            clock.advance(ms),
            signal ? new Promise((_, reject) => {
              const onAbort = () => {
                const err = new Error("Scripted agent aborted during hang");
                err.name = "AbortError";
                reject(err);
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            }) : new Promise(() => {
            })
          ]);
        } else {
          await clock.advance(ms);
        }
        throw Object.assign(new Error(`Scripted agent hang after ${ms}ms (vector ${vector.id})`), {
          code: "AGENT_TIMEOUT",
          details: { failureRetryable: false }
        });
      }
      if (result.kind === "fail") {
        const err = Object.assign(new Error(result.error), {
          code: result.retryable === false ? "AGENT_SCRIPT_FAIL" : "AGENT_SCRIPT_FAIL_RETRYABLE",
          details: { failureRetryable: result.retryable === true ? void 0 : false }
        });
        if (result.retryable === true) {
          delete err.details.failureRetryable;
        }
        throw err;
      }
      let output = result.output;
      if (options.schema && output !== void 0) {
        const parsed = options.schema.safeParse(output);
        if (!parsed.success) {
          const issues = parsed.error.issues.map(
            (issue) => issue && typeof issue === "object" && "message" in issue ? String(issue.message) : JSON.stringify(issue)
          ).join("; ");
          throw new TypeError(`Scripted agent output failed validation: ${issues}`);
        }
        output = parsed.data;
      }
      await writeFiles(rootDir, result.files);
      const generated = {};
      if (output !== void 0) generated.output = output;
      if (typeof result.text === "string") generated.text = result.text;
      generated.text = generated.text ?? (typeof output === "object" && output !== null ? JSON.stringify(output) : typeof output === "string" ? output : `scripted:${vector.id}`);
      return {
        ...generated,
        response: {
          messages: [{ role: "assistant", content: generated.text }]
        }
      };
    },
    lastPrompt() {
      return calls.at(-1)?.prompt;
    },
    reset() {
      calls.length = 0;
      used.clear();
      callIndex = 0;
    }
  };
  return agent;
}
export {
  scriptedAgent
};
