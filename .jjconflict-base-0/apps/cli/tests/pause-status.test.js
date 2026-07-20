import { describe, expect, test } from "bun:test";

const previousDisableAutoMain = process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN = "1";
const { formatStatusExitCode, isWaitingStatus, pauseCtas } = await import("../src/index.js");
if (previousDisableAutoMain === undefined) {
    delete process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
}
else {
    process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN = previousDisableAutoMain;
}

describe("gracefully paused run status", () => {
    test("uses the non-failure waiting exit code", () => {
        expect(formatStatusExitCode("paused")).toBe(3);
        expect(isWaitingStatus("paused")).toBe(true);
    });

    test("suggests resuming the paused run", () => {
        expect(pauseCtas("paused", "run-617")).toEqual([
            { command: "up --resume run-617", description: "Resume the paused run" },
        ]);
    });
});
