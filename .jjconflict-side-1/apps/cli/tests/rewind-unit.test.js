import { describe, expect, test } from "bun:test";
import { runRewindOnce } from "../src/rewind.js";

function stream(isTTY = false) {
    return {
        isTTY,
        chunks: [],
        write(text) {
            this.chunks.push(text);
        },
        text() {
            return this.chunks.join("");
        },
    };
}

function input(overrides = {}) {
    return {
        adapter: {},
        runId: "run-rewind",
        frameNo: 2,
        yes: false,
        json: false,
        stdin: stream(false),
        stdout: stream(false),
        stderr: stream(false),
        ...overrides,
    };
}

describe("rewind command confirmation", () => {
    test("declines when confirmation is required but unavailable", async () => {
        const command = input();
        const result = await runRewindOnce(command);

        expect(result.exitCode).not.toBe(0);
        expect(command.stderr.text()).toContain("ConfirmationRequired");
    });

    test("declines when custom confirmation returns false", async () => {
        const command = input({ confirm: async () => false });
        const result = await runRewindOnce(command);

        expect(result.exitCode).not.toBe(0);
        expect(command.stderr.text()).toContain("rewind declined by user");
    });

    test("continues after confirmation and maps route errors", async () => {
        const command = input({
            confirm: async () => true,
        });
        const result = await runRewindOnce(command);

        expect(result.exitCode).not.toBe(0);
        expect(command.stderr.text()).not.toContain("rewind declined");
    });
});
