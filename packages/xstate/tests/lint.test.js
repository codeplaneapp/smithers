import { describe, expect, test } from "bun:test";
import { assign, cancel, createMachine, emit, enqueueActions, log, raise, sendTo, setup, spawnChild, stopChild } from "xstate";
import { lintMachine } from "../src/index.js";

const child = createMachine({ initial: "x", states: { x: {} } });

describe("lintMachine rejections", () => {
    test("invoke is rejected naming the Task alternative", () => {
        const machine = createMachine({
            initial: "a",
            states: { a: { invoke: { src: child } } },
        });
        expect(() => lintMachine("m", machine)).toThrow(/XSTATE_INVOKE_UNSUPPORTED|<Task>/);
    });

    test("nested invoke with onDone is rejected wherever it hides", () => {
        const machine = createMachine({
            initial: "outer",
            states: {
                outer: {
                    initial: "inner",
                    states: {
                        inner: { invoke: { src: child, onDone: "sibling" } },
                        sibling: {},
                    },
                },
            },
        });
        expect(() => lintMachine("m", machine)).toThrow(/uses invoke/);
    });

    test("after (delayed transitions) is rejected naming WaitForEvent/timedOut, not the injected raise", () => {
        const machine = createMachine({
            initial: "a",
            states: { a: { after: { 1000: "b" } }, b: {} },
        });
        expect(() => lintMachine("m", machine)).toThrow(/XSTATE_AFTER_UNSUPPORTED|WaitForEvent/);
        expect(() => lintMachine("m", machine)).not.toThrow(/RAISE/);
    });

    test.each([
        ["raise", raise({ type: "X" }), /XSTATE_RAISE_UNSUPPORTED|signal/],
        ["sendTo", sendTo("someone", { type: "X" }), /XSTATE_SEND_TO_UNSUPPORTED|durable channels/],
        ["emit", emit({ type: "X" }), /XSTATE_EMIT_UNSUPPORTED|snapshot/],
        ["enqueueActions", enqueueActions(() => { }), /XSTATE_ENQUEUE_ACTIONS_UNSUPPORTED|assign/],
        ["spawnChild", spawnChild(child), /XSTATE_SPAWN_UNSUPPORTED|<Task>/],
        ["stopChild", stopChild("id"), /XSTATE_STOP_CHILD_UNSUPPORTED|unmounting/],
        ["cancel", cancel("id"), /XSTATE_CANCEL_UNSUPPORTED|timedOut/],
        ["log", log("hello"), /XSTATE_ACTION_UNSUPPORTED|inert/],
    ])("%s in entry actions is rejected with its Smithers-native alternative", (_name, action, pattern) => {
        const machine = createMachine({
            initial: "a",
            states: { a: { entry: [action] } },
        });
        expect(() => lintMachine(`m-${_name}`, machine)).toThrow(pattern);
    });

    test("custom inline function actions are rejected (silently-inert is worse than an error)", () => {
        const machine = createMachine({
            initial: "a",
            states: { a: { on: { GO: { target: "a", actions: [() => { }] } } } },
        });
        expect(() => lintMachine("m", machine)).toThrow(/XSTATE_ACTION_UNSUPPORTED|Custom actions/);
    });

    test("named custom actions from setup() are rejected; named assign is allowed", () => {
        const rejected = setup({ actions: { sideEffect: () => { } } }).createMachine({
            initial: "a",
            states: { a: { exit: ["sideEffect"] } },
        });
        expect(() => lintMachine("m", rejected)).toThrow(/declares custom action "sideEffect"/);

        const allowed = setup({ actions: { bump: assign({ n: 1 }) } }).createMachine({
            context: { n: 0 },
            initial: "a",
            states: { a: { entry: ["bump"], on: { GO: { target: "a", actions: [{ type: "bump" }] } } } },
        });
        expect(() => lintMachine("m2", allowed)).not.toThrow();
    });

    test("unregistered named actions are rejected (cannot be verified)", () => {
        const machine = createMachine({
            initial: "a",
            states: { a: { entry: ["mystery"] } },
        });
        expect(() => lintMachine("m", machine)).toThrow(/XSTATE_ACTION_UNSUPPORTED|no implementation/);
    });

    test("transition and always actions are walked too", () => {
        const inTransition = createMachine({
            initial: "a",
            states: { a: { on: { GO: { target: "a", actions: [raise({ type: "X" })] } } } },
        });
        expect(() => lintMachine("m", inTransition)).toThrow(/uses raise\(\)/);
        const inAlways = createMachine({
            context: { n: 0 },
            initial: "a",
            states: {
                a: { always: [{ guard: ({ context }) => context.n > 0, target: "b", actions: [() => { }] }] },
                b: {},
            },
        });
        expect(() => lintMachine("m2", inAlways)).toThrow(/Custom actions/);
    });

    test("a clean machine passes: assign, guards, always, nested onDone, final output", () => {
        const machine = setup({
            guards: { ready: ({ context }) => context.n >= 0 },
        }).createMachine({
            context: { n: 0 },
            output: ({ context }) => context,
            initial: "phase",
            states: {
                phase: {
                    initial: "work",
                    states: {
                        work: { on: { STEP: { guard: "ready", target: "end", actions: assign({ n: 1 }) } } },
                        end: { type: "final" },
                    },
                    onDone: "wrap",
                },
                wrap: { type: "final" },
            },
        });
        expect(() => lintMachine("clean", machine)).not.toThrow();
    });

    test("lint is memoized per machine identity and re-runs for a new machine object", () => {
        const build = () => createMachine({ initial: "a", states: { a: { invoke: { src: child } } } });
        const first = build();
        expect(() => lintMachine("m", first)).toThrow(/uses invoke/);
        // Same (bad) machine object throws again — memoization only records passes.
        expect(() => lintMachine("m", first)).toThrow(/uses invoke/);
        // A hot-reloaded (new) machine object is re-linted from scratch.
        expect(() => lintMachine("m", build())).toThrow(/uses invoke/);
    });
});

describe("lintMachine re-entry task-identity", () => {
    test("a bare-constant meta.smithersTaskId on a state the machine can re-enter (cycle) is rejected", () => {
        const machine = createMachine({
            initial: "a",
            states: {
                a: { meta: { smithersTaskId: "draft" }, on: { NEXT: "b" } },
                b: { on: { BACK: "a", DONE: "c" } },
                c: { type: "final" },
            },
        });
        expect(() => lintMachine("m", machine)).toThrow(/bare constant|deadlock/);
    });

    test("a direct self-transition (reenter: true) with a bare-constant id is rejected", () => {
        const machine = createMachine({
            initial: "a",
            states: {
                a: { meta: { smithersTaskId: "draft" }, on: { RETRY: { target: "a", reenter: true } } },
            },
        });
        expect(() => lintMachine("m", machine)).toThrow(/bare constant|deadlock/);
    });

    test("a bare-constant id on a descendant of a re-enterable compound state is rejected", () => {
        const machine = createMachine({
            initial: "a",
            states: {
                a: {
                    initial: "inner",
                    states: { inner: { meta: { smithersTaskId: "draft" } } },
                    on: { AGAIN: { target: "a", reenter: true } },
                },
            },
        });
        expect(() => lintMachine("m", machine)).toThrow(/bare constant|deadlock/);
    });

    test("a context-derived (function) smithersTaskId on a re-enterable state is allowed", () => {
        const machine = createMachine({
            context: { rev: 0 },
            initial: "a",
            states: {
                a: { meta: { smithersTaskId: (context) => `draft-r${context.rev}` }, on: { NEXT: "b" } },
                b: { on: { BACK: "a", DONE: "c" } },
                c: { type: "final" },
            },
        });
        expect(() => lintMachine("m", machine)).not.toThrow();
    });

    test("a bare-constant smithersTaskId on a state the machine can never re-enter is allowed", () => {
        const machine = createMachine({
            initial: "a",
            states: {
                a: { meta: { smithersTaskId: "draft" }, on: { NEXT: "b" } },
                b: { type: "final" },
            },
        });
        expect(() => lintMachine("m", machine)).not.toThrow();
    });

    test("states without a declared smithersTaskId are unaffected even on a cycle", () => {
        const machine = createMachine({
            initial: "a",
            states: {
                a: { on: { NEXT: "b" } },
                b: { on: { BACK: "a", DONE: "c" } },
                c: { type: "final" },
            },
        });
        expect(() => lintMachine("m", machine)).not.toThrow();
    });
});
