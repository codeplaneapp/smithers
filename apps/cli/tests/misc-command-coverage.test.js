import { describe, expect, test } from "bun:test";
import { openInBrowser } from "../src/openInBrowser.js";
import { renderInitNextSteps } from "../src/renderInitNextSteps.js";
import { runStartersCommand } from "../src/starter-gallery-command.js";
import { buildStarterGallery } from "../src/starter-gallery.js";

describe("openInBrowser", () => {
    // Force the non-darwin launcher (`xdg-open`, absent on the test box) so the
    // spawn succeeds structurally without actually opening a browser tab.
    function withPlatform(platform, fn) {
        const original = Object.getOwnPropertyDescriptor(process, "platform");
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        try {
            return fn();
        } finally {
            Object.defineProperty(process, "platform", original);
        }
    }

    test("spawns a launcher for an http URL", () => {
        withPlatform("linux", () => {
            expect(openInBrowser("https://example.test/never-opened")).toBe(true);
        });
    });

    test("converts a filesystem path to a file:// URL and spawns", () => {
        withPlatform("linux", () => {
            expect(openInBrowser("/tmp/smithers-open-in-browser-test.html")).toBe(true);
        });
    });

    test("returns false when the launcher cannot be spawned", () => {
        withPlatform("linux", () => {
            // A NUL byte in the URL makes spawn throw synchronously (ERR_INVALID_ARG_VALUE),
            // which openInBrowser swallows into a `false` return.
            expect(openInBrowser(`https://example.test/${String.fromCharCode(0)}`)).toBe(false);
        });
    });
});

describe("renderInitNextSteps", () => {
    test("renders a bare outro when there are no commands", () => {
        expect(() => renderInitNextSteps({ commands: [] })).not.toThrow();
    });

    test("renders command rows with descriptions and a docs tip", () => {
        expect(() =>
            renderInitNextSteps({
                description: "Next steps",
                commands: [
                    { command: "up hello", description: "Run the hello workflow" },
                    { command: "ps" },
                ],
                tip: "Point your agent at https://smithers.sh/llms-full.txt for the full API.",
            }),
        ).not.toThrow();
    });
});

describe("runStartersCommand", () => {
    function makeContext(overrides = {}) {
        const calls = { ok: [], error: [], stdout: [] };
        const ctx = {
            args: {},
            options: {},
            ok: (...a) => {
                calls.ok.push(a);
                return { kind: "ok", a };
            },
            error: (...a) => {
                calls.error.push(a);
                return { kind: "error", a };
            },
            ...overrides,
        };
        return { ctx, calls };
    }

    test("fails with STARTER_NOT_FOUND for an unknown starter id", () => {
        const { ctx } = makeContext({ args: { id: "does-not-exist" } });
        const fail = (opts) => ({ kind: "fail", opts });
        const result = runStartersCommand(ctx, fail);
        expect(result.kind).toBe("fail");
        expect(result.opts.code).toBe("STARTER_NOT_FOUND");
        expect(result.opts.details.availableStarters).toContain(buildStarterGallery().starters[0].id);
    });

    test("returns structured output when a json format is requested", () => {
        const { ctx, calls } = makeContext({ args: { id: "idea-to-tickets" }, options: {}, format: "json" });
        const result = runStartersCommand(ctx, () => {
            throw new Error("should not fail");
        });
        expect(result.kind).toBe("ok");
        expect(calls.ok).toHaveLength(1);
    });

    test("prints the human gallery when no explicit format is set", () => {
        const { ctx } = makeContext({ args: {}, options: { goal: "plan" } });
        const result = runStartersCommand(ctx, () => {
            throw new Error("should not fail");
        });
        expect(result).toBeUndefined();
    });
});
