import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseCliAgent } from "../src/BaseCliAgent/index.js";

class CodexPreflightAgent extends BaseCliAgent {
    /** @param {string} codexHome */
    constructor(codexHome) {
        super({ id: "codex-preflight-test" });
        this.codexHome = codexHome;
        this.cleanupCalls = 0;
    }

    async buildCommand() {
        return {
            command: "codex",
            args: [],
            outputFormat: "text",
            env: {
                OPENAI_API_KEY: "",
                // Isolate CODEX_HOME to an empty dir so codex diagnostics find no
                // subscription/API-key auth (otherwise the developer's real
                // ~/.codex/auth.json would make the key check pass). See #448.
                CODEX_HOME: this.codexHome,
            },
            cleanup: async () => {
                this.cleanupCalls += 1;
            },
        };
    }
}

describe("BaseCliAgent preflight", () => {
    test("fails non-retryably when diagnostics report a failing check", async () => {
        const codexHome = mkdtempSync(join(tmpdir(), "smithers-codex-preflight-"));
        const agent = new CodexPreflightAgent(codexHome);
        let error;
        try {
            await agent.preflight({ rootDir: process.cwd() });
        }
        catch (err) {
            error = err;
        }
        finally {
            rmSync(codexHome, { recursive: true, force: true });
        }
        expect(error?.code).toBe("AGENT_CONFIG_INVALID");
        expect(error?.details?.failureRetryable).toBe(false);
        expect(error?.details?.preflight).toBe(true);
        expect(error?.details?.diagnostics?.checks.some((check) => check.status === "fail")).toBe(true);
        expect(agent.cleanupCalls).toBe(1);
    });
});
