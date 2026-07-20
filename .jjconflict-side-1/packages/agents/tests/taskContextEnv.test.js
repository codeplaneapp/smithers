import { describe, expect, test } from "bun:test";
import { taskContextEnv } from "../src/BaseCliAgent/taskContextEnv.js";

describe("taskContextEnv", () => {
    test("returns an empty object for missing context", () => {
        expect(taskContextEnv(undefined)).toEqual({});
        expect(taskContextEnv(null)).toEqual({});
    });

    test("maps a full task context to SMITHERS_* vars as strings", () => {
        expect(
            taskContextEnv({
                runId: "run-1",
                nodeId: "implement",
                iteration: 2,
                attempt: 1,
            }),
        ).toEqual({
            SMITHERS_RUN_ID: "run-1",
            SMITHERS_NODE_ID: "implement",
            SMITHERS_ITERATION: "2",
            SMITHERS_ATTEMPT: "1",
        });
    });

    test("includes iteration 0 but omits blank/invalid fields", () => {
        expect(
            taskContextEnv({
                runId: "",
                nodeId: "implement",
                iteration: 0,
                // @ts-expect-error intentionally invalid attempt
                attempt: "nope",
            }),
        ).toEqual({
            SMITHERS_NODE_ID: "implement",
            SMITHERS_ITERATION: "0",
        });
    });
});
