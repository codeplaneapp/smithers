import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { listNarratorCandidates } from "../narrator-agents.js";
import { runPromise } from "../smithersRuntime.js";
import { oneshotCodexPaused } from "./oneshotCodexPaused.js";

// Live status narrator for `smithers oneshot`. While the implement/review
// agents work, a cheap narrator (Codex `gpt-5.6-luna` first) watches their
// recorded output and writes one-line "what is it doing" updates as
// `NodeOutput` events on a pseudo-node ("status") that the oneshot UI polls.
//
// Cache reuse: with Codex the narrator keeps ONE thread and resumes it
// (`codex exec resume <threadId>`) on every update, appending only the output
// recorded since the last call, so the provider prefix cache absorbs the
// shared conversation instead of re-billing the whole transcript each tick.
// Non-Codex narrators cannot resume; they re-read a bounded tail instead.

const STATUS_NODE_ID = "status";
const WATCHED_NODE_IDS = new Set(["implement", "review"]);
const POLL_MS = 4_000;
const MIN_NARRATE_MS = 15_000;
const MAX_DELTA_CHARS = 6_000;
const MAX_TAIL_CHARS = 3_000;
const MAX_STATUS_CHARS = 140;
const NARRATE_TIMEOUT_MS = 90_000;
const MAX_CONSECUTIVE_FAILURES = 3;

const SYSTEM_PROMPT = [
    "You are the live status line for a coding agent working a task while a human watches from a dashboard.",
    "Given the agent's latest activity, reply with ONE short line (100 chars max) saying what the agent is doing right now, present tense: \"Editing packages/db/adapter.js\", \"Running the oneshot tests\", \"Reading the workflow graph\".",
    "Plain text only: no markdown, no quotes, no emoji, no trailing period. Name concrete files or commands when they appear. Never mention yourself, never ask questions.",
].join("\n");

/** @param {unknown} value */
function parsePayload(value) {
    if (value && typeof value === "object") return /** @type {Record<string, unknown>} */ (value);
    if (typeof value !== "string") return undefined;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}

/** @param {unknown} text @returns {string | null} */
export function cleanStatusLine(text) {
    const first = String(text ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
    let cleaned = first.replace(/^[-*•>\s"`']+/, "").replace(/["'`]+$/, "").replace(/[.…\s]+$/, "").trim();
    if (!cleaned) return null;
    if (cleaned.length > MAX_STATUS_CHARS) cleaned = `${cleaned.slice(0, MAX_STATUS_CHARS - 1)}…`;
    return cleaned;
}

/**
 * Start the sidecar loop. Returns a handle whose `stop()` ends it; the loop
 * also stops itself after repeated narrator failures. Every failure is
 * swallowed — status narration must never break the oneshot run it watches.
 *
 * @param {{ db: any; runId: string; goal: string; cwd: string; env?: NodeJS.ProcessEnv }} options
 * @returns {{ stop: () => Promise<void> }}
 */
export function startOneshotStatusUpdater(options) {
    const env = options.env ?? process.env;
    let candidates = options.candidates ?? listNarratorCandidates(env, options.cwd);
    if (oneshotCodexPaused(env)) candidates = candidates.filter((candidate) => candidate.id !== "codex");
    if (candidates.length === 0) return { stop() { return Promise.resolve(); } };
    const adapter = options.adapter ?? new SmithersDb(options.db);
    const state = {
        stopped: false,
        inFlight: false,
        afterSeq: 0,
        delta: "",
        tail: "",
        lastNarrateAt: 0,
        candidateIndex: 0,
        /** @type {ReturnType<(typeof listNarratorCandidates)>[number]["build"] | undefined} */
        agent: undefined,
        /** @type {string | undefined} */
        threadId: undefined,
        failures: 0,
        activeTick: undefined,
        abortController: undefined,
    };

    function stop() {
        if (!state.stopped) {
            state.stopped = true;
            state.abortController?.abort();
        }
        clearInterval(timer);
        return state.activeTick ?? Promise.resolve();
    }

    async function narrate() {
        const candidate = candidates[state.candidateIndex];
        if (!candidate) return stop();
        if (!state.agent) state.agent = candidate.build(SYSTEM_PROMPT);
        const delta = state.delta;
        const canResume = candidate.id === "codex" && typeof state.threadId === "string";
        const prompt = canResume
            ? `New activity from the agent:\n${delta}\n\nUpdate the status line.`
            : candidate.id === "codex"
                ? `Goal: ${options.goal}\n\nAgent activity so far:\n${delta}\n\nReply with the status line.`
                : `Goal: ${options.goal}\n\nAgent activity so far (tail):\n${state.tail}\n\nReply with the status line.`;
        try {
            /** @type {string | undefined} */
            let threadId;
            state.abortController = new AbortController();
            const generated = await state.agent.generate({
                prompt,
                timeout: { totalMs: NARRATE_TIMEOUT_MS },
                abortSignal: state.abortController.signal,
                ...(canResume ? { resumeSession: state.threadId } : {}),
                onEvent: (/** { resume?: unknown } */ event) => {
                    if (typeof event?.resume === "string") threadId = event.resume;
                },
            });
            const raw = typeof generated === "string" ? generated : (generated?.text ?? "");
            const line = cleanStatusLine(raw);
            if (!line) throw new Error("narrator returned an empty status line");
            if (state.stopped) return;
            state.delta = "";
            state.failures = 0;
            if (threadId) state.threadId = threadId;
            if (state.stopped) return;
            const timestampMs = Date.now();
            await runPromise(adapter.insertEventWithNextSeqEffect({
                runId: options.runId,
                timestampMs,
                type: "NodeOutput",
                payloadJson: JSON.stringify({
                    type: "NodeOutput",
                    runId: options.runId,
                    nodeId: STATUS_NODE_ID,
                    text: `${line}\n`,
                    stream: "stdout",
                    engine: candidate.id,
                    timestampMs,
                }),
            }));
        }
        catch {
            if (state.stopped) return;
            state.failures += 1;
            state.agent = undefined;
            state.threadId = undefined;
            if (state.failures >= MAX_CONSECUTIVE_FAILURES) {
                if (state.candidateIndex + 1 < candidates.length) {
                    state.candidateIndex += 1;
                    state.failures = 0;
                }
                else {
                    stop();
                }
            }
        }
        finally {
            state.abortController = undefined;
        }
    }

    async function tick() {
        if (state.stopped || state.inFlight) return;
        state.inFlight = true;
        try {
            const events = await adapter.listEvents(options.runId, state.afterSeq, 1000);
            if (state.stopped) return;
            for (const event of events) {
                const seq = Number(event.seq ?? 0);
                if (Number.isFinite(seq) && seq > state.afterSeq) state.afterSeq = seq;
                if (event.type !== "NodeOutput") continue;
                const payload = parsePayload(event.payloadJson ?? event.payload_json);
                const nodeId = typeof payload?.nodeId === "string" ? payload.nodeId : "";
                if (!WATCHED_NODE_IDS.has(nodeId)) continue;
                const text = typeof payload.text === "string" ? payload.text : "";
                if (!text.trim()) continue;
                const chunk = `[${nodeId}] ${text}`;
                state.delta += chunk;
                state.tail = (state.tail + chunk).slice(-MAX_TAIL_CHARS);
            }
            if (state.delta.length > MAX_DELTA_CHARS) state.delta = state.delta.slice(-MAX_DELTA_CHARS);
            const now = Date.now();
            if (state.delta.trim() && now - state.lastNarrateAt >= MIN_NARRATE_MS) {
                state.lastNarrateAt = now;
                await narrate();
            }
        }
        catch {
            /* The store may not exist yet (engine still starting); the next tick retries. */
        }
        finally {
            state.inFlight = false;
        }
    }

    const timer = setInterval(() => {
        if (state.stopped || state.inFlight) return;
        const activeTick = tick();
        state.activeTick = activeTick;
        void activeTick.finally(() => {
            if (state.activeTick === activeTick) state.activeTick = undefined;
        });
    }, options.pollMs ?? POLL_MS);
    if (typeof timer.unref === "function") timer.unref();
    return { stop };
}
