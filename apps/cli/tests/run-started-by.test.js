import { describe, expect, test } from "bun:test";
import { resolveCliStartedBy } from "../src/runStartedBy.js";

describe("resolveCliStartedBy", () => {
    test("prefers Codex thread attribution over inherited Claude environment", () => {
        expect(resolveCliStartedBy({}, {
            CODEX_THREAD_ID: "codex-thread",
            CODEX_CI: "1",
            CLAUDE_CODE_SESSION_ID: "claude-session",
            CLAUDECODE: "1",
        })).toEqual({ harness: "codex", sessionId: "codex-thread", detected: true });
    });

    test("merges explicit fields with only the missing detected identity", () => {
        expect(resolveCliStartedBy({ harness: "openclaw", prompt: "explicit" }, {
            CLAUDE_CODE_SESSION_ID: "claude-session",
        })).toEqual({ harness: "openclaw", sessionId: "claude-session", prompt: "explicit", detected: true });
        expect(resolveCliStartedBy({ sessionId: "manual" }, { CODEX_CI: "1" }))
            .toEqual({ harness: "codex", sessionId: "manual", detected: true });
    });

    test("does not infer installation or configuration markers", () => {
        expect(resolveCliStartedBy({}, {
            CODEX_HOME: "/tmp/codex",
            KIMI_SHARE_DIR: "/tmp/kimi",
            KIMI_CODE_HOME: "/tmp/kimi-code",
            OPENCODE_CONFIG: "/tmp/open.json",
        })).toBeUndefined();
    });
});
