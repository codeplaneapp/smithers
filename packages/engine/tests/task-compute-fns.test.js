import { describe, expect, test } from "bun:test";
import { attachSandboxComputeFns, attachSubflowComputeFns } from "../src/task-compute-fns.js";

describe("task compute function attachment", () => {
    test("attaches subflow compute functions and removes non-persistable workflow metadata", () => {
        const existingComputeFn = () => "already attached";
        const subflowWorkflow = { name: "child" };
        const tasks = [
            {
                nodeId: "subflow",
                meta: {
                    __subflow: true,
                    __subflowWorkflow: subflowWorkflow,
                    __subflowInput: { value: 1 },
                    keep: "yes",
                },
            },
            {
                nodeId: "already",
                computeFn: existingComputeFn,
                meta: {
                    __subflow: true,
                    __subflowWorkflow: subflowWorkflow,
                },
            },
            {
                nodeId: "missing-workflow",
                meta: { __subflow: true },
            },
        ];

        attachSubflowComputeFns(tasks, { name: "parent" }, { rootDir: "/repo", workflowPath: "wf.tsx" });

        expect(typeof tasks[0].computeFn).toBe("function");
        expect(tasks[0].meta).toEqual({
            __subflow: true,
            __subflowInput: { value: 1 },
            keep: "yes",
        });
        expect(tasks[1].computeFn).toBe(existingComputeFn);
        expect(tasks[1].meta.__subflowWorkflow).toBe(subflowWorkflow);
        expect(tasks[2].computeFn).toBeUndefined();
    });

    test("attaches sandbox compute functions with defaults and strips bulky/provider metadata", () => {
        const sandboxWorkflow = { name: "sandbox" };
        const existingComputeFn = () => "already attached";
        const tasks = [
            {
                nodeId: "sandbox",
                worktreePath: "/worktree",
                meta: {
                    __sandbox: true,
                    __sandboxWorkflow: sandboxWorkflow,
                    __sandboxInput: { ticket: 305 },
                    __sandboxProvider: "local",
                    __sandboxRuntime: "bun",
                    __sandboxAllowNetwork: 1,
                    __sandboxReviewDiffs: false,
                    __sandboxAutoAcceptDiffs: true,
                    __sandboxAllowNested: "",
                    __sandboxConfig: { image: "test" },
                    keep: "yes",
                },
            },
            {
                nodeId: "already",
                computeFn: existingComputeFn,
                meta: {
                    __sandbox: true,
                    __sandboxWorkflow: sandboxWorkflow,
                    __sandboxProvider: "local",
                },
            },
            {
                nodeId: "missing-workflow",
                meta: { __sandbox: true },
            },
        ];

        attachSandboxComputeFns(tasks, { name: "parent" }, { rootDir: "/repo" });

        expect(typeof tasks[0].computeFn).toBe("function");
        expect(tasks[0].meta).toEqual({
            __sandbox: true,
            __sandboxInput: { ticket: 305 },
            __sandboxRuntime: "bun",
            __sandboxAllowNetwork: 1,
            __sandboxReviewDiffs: false,
            __sandboxAutoAcceptDiffs: true,
            __sandboxAllowNested: "",
            __sandboxConfig: { image: "test" },
            keep: "yes",
        });
        expect(tasks[1].computeFn).toBe(existingComputeFn);
        expect(tasks[1].meta.__sandboxWorkflow).toBe(sandboxWorkflow);
        expect(tasks[1].meta.__sandboxProvider).toBe("local");
        expect(tasks[2].computeFn).toBeUndefined();
    });
});
