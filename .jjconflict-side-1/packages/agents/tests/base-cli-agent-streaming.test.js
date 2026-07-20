import { describe, expect, test } from "bun:test";
import { createAgentStdoutTextEmitter } from "../src/BaseCliAgent/index.js";
describe("CLI agent stdout transcript emitter", () => {
    test("emits streamed assistant deltas without duplicating the final turn payload", () => {
        let streamed = "";
        const emitter = createAgentStdoutTextEmitter({
            outputFormat: "stream-json",
            onText: (text) => {
                streamed += text;
            },
        });
        emitter.push(JSON.stringify({
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hello" },
        }) + "\n");
        emitter.push(JSON.stringify({
            type: "content_block_delta",
            delta: { type: "text_delta", text: " world" },
        }) + "\n");
        emitter.push(JSON.stringify({
            type: "turn_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "Hello world" }],
            },
        }) + "\n");
        emitter.flush("Hello world");
        expect(streamed).toBe("Hello world");
    });
    test("does not duplicate the answer when the CLI emits an assistant message and a result echo (Claude Code)", () => {
        // Claude Code stream-json emits a complete `assistant` line followed by
        // a `result` line that repeats the same answer, with no deltas. Both must
        // not be surfaced, or the engine persists two identical NodeOutput events
        // and every consumer (TUI, `smithers chat`, gateway UI) shows it twice.
        /** @type {string[]} */
        const chunks = [];
        const emitter = createAgentStdoutTextEmitter({
            outputFormat: "stream-json",
            onText: (text) => {
                chunks.push(text);
            },
        });
        const answer = '{"reviewer":"reviewer-1","approved":false,"feedback":"ok"}';
        emitter.push(JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: answer }] },
        }) + "\n");
        emitter.push(JSON.stringify({
            type: "result",
            subtype: "success",
            result: answer,
        }) + "\n");
        emitter.flush(answer);
        expect(chunks).toEqual([answer]);
    });
    test("still surfaces a result payload when no assistant message preceded it", () => {
        // Agents that emit only a terminal `result` (and never an assistant
        // line) must still have their answer surfaced — the dedup is a repeat
        // guard, not a blanket suppression of `result`.
        /** @type {string[]} */
        const chunks = [];
        const emitter = createAgentStdoutTextEmitter({
            outputFormat: "stream-json",
            onText: (text) => {
                chunks.push(text);
            },
        });
        emitter.push(JSON.stringify({ type: "result", subtype: "success", result: "Only a result" }) + "\n");
        emitter.flush("Only a result");
        expect(chunks).toEqual(["Only a result"]);
    });
    test("falls back to the final extracted text when the CLI did not stream deltas", () => {
        let streamed = "";
        const emitter = createAgentStdoutTextEmitter({
            outputFormat: "json",
            onText: (text) => {
                streamed += text;
            },
        });
        emitter.push(JSON.stringify({ type: "turn.completed" }) + "\n");
        emitter.flush("Final assistant reply");
        expect(streamed).toBe("Final assistant reply");
    });
});
