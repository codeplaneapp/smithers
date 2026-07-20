import { describe, expect, test } from "bun:test";
import { reportReplayResult } from "../src/reportReplayResult.js";

function capture() {
    let out = "";
    return {
        write: (s) => {
            out += s;
        },
        get: () => out,
    };
}

describe("reportReplayResult", () => {
    test("prints vcsError when replay could not restore VCS state", () => {
        const stderr = capture();

        reportReplayResult({
            result: {
                runId: "child-run",
                vcsRestored: false,
                vcsPointer: null,
                vcsError: "no VCS tag found",
            },
            parentRunId: "parent-run",
            parentFrame: 7,
            stderr,
        });

        expect(stderr.get()).toContain("Forked run child-run from parent-run:7");
        expect(stderr.get()).toContain("VCS state was not restored: no VCS tag found");
    });
});
