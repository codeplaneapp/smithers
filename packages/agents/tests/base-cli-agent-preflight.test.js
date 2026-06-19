import { describe, expect, test } from "bun:test";
import { BaseCliAgent } from "../src/BaseCliAgent/index.js";

class CodexPreflightAgent extends BaseCliAgent {
    constructor() {
        super({ id: "codex-preflight-test" });
        this.cleanupCalls = 0;
    }

    async buildCommand() {
        return {
            command: "codex",
            args: [],
            outputFormat: "text",
            env: {
                OPENAI_API_KEY: "",
            },
            cleanup: async () => {
                this.cleanupCalls += 1;
            },
        };
    }
}

describe("BaseCliAgent preflight", () => {
    test("fails non-retryably when diagnostics report a failing check", async () => {
        const agent = new CodexPreflightAgent();
        let error;
        try {
            await agent.preflight({ rootDir: process.cwd() });
        }
        catch (err) {
            error = err;
        }
        expect(error?.code).toBe("AGENT_CONFIG_INVALID");
        expect(error?.details?.failureRetryable).toBe(false);
        expect(error?.details?.preflight).toBe(true);
        expect(error?.details?.diagnostics?.checks.some((check) => check.status === "fail")).toBe(true);
        expect(agent.cleanupCalls).toBe(1);
    });
});
