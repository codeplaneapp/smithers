import { describe, expect, test } from "bun:test";
import {
    normalizeRunStartedBy,
    RUN_STARTED_BY_HARNESS_MAX_CODE_POINTS,
    RUN_STARTED_BY_PROMPT_MAX_CODE_POINTS,
    RUN_STARTED_BY_SESSION_ID_MAX_CODE_POINTS,
} from "../src/index.js";

describe("normalizeRunStartedBy", () => {
    test("normalizes empty values and only preserves detected with identity", () => {
        expect(normalizeRunStartedBy({ harness: "  ", sessionId: "", prompt: "", detected: true })).toBeUndefined();
        expect(normalizeRunStartedBy({ prompt: "  ", detected: true })).toEqual({ prompt: "  " });
        expect(normalizeRunStartedBy({ harness: " codex ", sessionId: " session ", detected: true })).toEqual({
            harness: "codex",
            sessionId: "session",
            detected: true,
        });
    });

    test("uses code-point limits and clips prompt visibly", () => {
        expect(normalizeRunStartedBy({ harness: "😀".repeat(RUN_STARTED_BY_HARNESS_MAX_CODE_POINTS) }).harness).toHaveLength(RUN_STARTED_BY_HARNESS_MAX_CODE_POINTS * 2);
        expect(() => normalizeRunStartedBy({ harness: "😀".repeat(RUN_STARTED_BY_HARNESS_MAX_CODE_POINTS + 1) })).toThrow("startedBy.harness");
        expect(() => normalizeRunStartedBy({ sessionId: "😀".repeat(RUN_STARTED_BY_SESSION_ID_MAX_CODE_POINTS + 1) })).toThrow("startedBy.sessionId");
        const prompt = "😀".repeat(RUN_STARTED_BY_PROMPT_MAX_CODE_POINTS + 1);
        const normalized = normalizeRunStartedBy({ prompt });
        expect(Array.from(normalized.prompt)).toHaveLength(RUN_STARTED_BY_PROMPT_MAX_CODE_POINTS);
        expect(normalized.prompt.endsWith("…")).toBe(true);
    });

    test("rejects invalid known fields and ignores unknown direct-caller keys", () => {
        expect(() => normalizeRunStartedBy({ harness: 1 })).toThrow("startedBy.harness");
        expect(() => normalizeRunStartedBy("codex")).toThrow("startedBy must be an object");
        expect(normalizeRunStartedBy({ harness: "codex", unknown: "ignored" })).toEqual({ harness: "codex" });
    });
});
