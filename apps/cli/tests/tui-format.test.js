import { describe, expect, test } from "bun:test";
import { formatStreamText, formatToolCall } from "../src/tui-format.js";

/**
 * Strip ANSI escape codes so assertions are stable regardless of whether
 * picocolors emits color (TTY) or not (CI / piped).
 * @param {string} str
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping
const stripAnsi = (str) => str.replace(/\x1B\[[0-9;]*m/g, "");

const fmt = (text) => stripAnsi(formatToolCall(text));
const stream = (text) => stripAnsi(formatStreamText(text));

describe("formatToolCall", () => {
    test("(a) strips /bin/zsh -lc shell wrapper down to the command", () => {
        const input =
            "[tool] /bin/zsh -lc 'git diff HEAD~7..HEAD -- apps/cli/src/tui.js apps/cli/src/tui-gates.js'";
        expect(fmt(input)).toBe(
            "$ git diff HEAD~7..HEAD -- apps/cli/src/tui.js apps/cli/src/tui-gates.js",
        );
    });

    test("(b) surfaces the command from a JSON tool input with description dimmed", () => {
        const input =
            '[tool] Bash: {"command":"git show 87d58925 --stat && git show 87d58925","description":"Show initial TUI commit content"}';
        expect(fmt(input)).toBe(
            "$ git show 87d58925 --stat && git show 87d58925 (Show initial TUI commit content)",
        );
    });

    test("(b) JSON command without description shows just the command", () => {
        const input = '[tool] Bash: {"command":"ls -la"}';
        expect(fmt(input)).toBe("$ ls -la");
    });

    test("(c) completed line returns a compact call + checkmark, not the output", () => {
        const input =
            "[tool] Bash → commit 87d5892...\nmany lines of\noutput here\nwith newlines";
        const out = fmt(input);
        expect(out).toContain("✓ bash");
        expect(out).toContain("✓");
        expect(out).not.toContain("many lines");
        expect(out).not.toContain("\n");
    });

    test("(c) completed line also works with ascii arrow", () => {
        const input = "[tool] Bash -> done\noutput";
        const out = fmt(input);
        expect(out).toBe("✓ bash");
        expect(out).not.toContain("output");
    });

    test("strips /bin/sh -c with double quotes", () => {
        const input = `[tool] /bin/sh -c "echo hello world"`;
        expect(fmt(input)).toBe("$ echo hello world");
    });

    test("strips bash -lc wrapper", () => {
        const input = "[tool] bash -lc 'pnpm test'";
        expect(fmt(input)).toBe("$ pnpm test");
    });

    test("strips zsh -c with bare (unquoted) command", () => {
        const input = "[tool] zsh -c make";
        expect(fmt(input)).toBe("$ make");
    });

    test("no wrapper: renders shell-looking commands with a command marker", () => {
        const input = "[tool] git status";
        expect(fmt(input)).toBe("$ git status");
    });

    test("bare quoted shell command is treated as a command", () => {
        const input = "[tool] 'git diff -- apps/cli/src/tui-format.js";
        expect(fmt(input)).toBe("$ git diff -- apps/cli/src/tui-format.js");
    });

    test("malformed JSON: keeps tool name + raw payload, minimally cleaned", () => {
        const input = '[tool] Bash: {"command":"git status",';
        const out = fmt(input);
        expect(out).toContain("bash");
        expect(out).toContain("git status");
        expect(out).not.toContain("\n");
    });

    test("non-command JSON: shows tool name + compact key=value params", () => {
        const home = process.env.HOME ?? "/Users/williamcory";
        const input =
            `[tool] Read: {"file_path":"${home}/smithers3/apps/cli/src/tui.js","limit":20}`;
        const out = fmt(input);
        expect(out).toContain("read");
        expect(out).toContain("~/smithers3/apps/cli/src/tui.js");
        expect(out).toContain("limit=20");
    });

    test("non-command JSON with no preferred keys falls back to first primitives", () => {
        const input = '[tool] Custom: {"alpha":"one","beta":2,"gamma":true}';
        const out = fmt(input);
        expect(out).toContain("custom");
        expect(out).toContain("alpha=one");
    });

    test("embedded newlines and tabs collapse to single spaces", () => {
        const input = "[tool] git diff\n\t--stat   \n   HEAD";
        expect(fmt(input)).toBe("$ git diff --stat HEAD");
    });

    test("empty string returns empty (defensive, no throw)", () => {
        expect(formatToolCall("")).toBe("");
    });

    test("whitespace-only string returns empty (nothing to render)", () => {
        expect(formatToolCall("   \n\t  ")).toBe("");
    });

    test("non-string input never throws", () => {
        // @ts-expect-error intentionally passing a non-string
        expect(() => formatToolCall(null)).not.toThrow();
        // @ts-expect-error intentionally passing a non-string
        expect(formatToolCall(null)).toBe("");
        // @ts-expect-error intentionally passing a non-string
        expect(() => formatToolCall(42)).not.toThrow();
    });

    test("text without a marker still gets a clean leading marker", () => {
        const input = "/bin/zsh -lc 'echo hi'";
        expect(fmt(input)).toBe("$ echo hi");
    });

    test("treats command markers as shell commands", () => {
        const input = "[command] bash -lc 'ls'";
        expect(fmt(input)).toBe("$ ls");
    });

    test("JSON command that is itself a shell wrapper is also unwrapped", () => {
        const input =
            '[tool] Bash: {"command":"/bin/zsh -lc \'git log --oneline\'","description":"log"}';
        expect(fmt(input)).toBe("$ git log --oneline (log)");
    });

    test("arrow inside a started JSON command is not treated as completion", () => {
        // The command itself contains " -> "; the call is still running (no
        // completion arrow was appended), so it must render as a live command,
        // not a truncated, checkmarked, malformed line.
        const input = '[tool] Bash: {"command":"echo a -> b"}';
        const out = fmt(input);
        expect(out).toBe("$ echo a -> b");
        expect(out).not.toContain("✓");
    });

    test("unicode arrow inside a started JSON command is not treated as completion", () => {
        const input = '[tool] Bash: {"command":"printf \'%s\' a → b"}';
        const out = fmt(input);
        expect(out).toBe("$ printf '%s' a → b");
        expect(out).not.toContain("✓");
    });

    test("a genuinely completed call is still detected as completed", () => {
        // Regression guard: the started-JSON exception must not swallow real
        // completion arrows on the bare-title completed form.
        const input = "[tool] Bash → done\noutput";
        expect(fmt(input)).toBe("✓ bash");
    });
});

describe("formatStreamText", () => {
    test("compacts Codex tracing logs", () => {
        const home = process.env.HOME ?? "/Users/williamcory";
        const input = [
            "2026-06-18T23:10:11.531195Z ERROR",
            `codex_core::session::session: failed to load skill ${home}/.agents/skills/smithers-snapshot-hook/SKILL.md: invalid YAML`,
        ].join("\n");

        expect(stream(input)).toBe("error failed to load skill ~/.agents/skills/smithers-snapshot-hook/SKILL.md: invalid YAML");
    });

    test("does not treat ordinary stream text as a tool call", () => {
        expect(stream("hello\nworld")).toBe("hello ↵ world");
    });

    test("does not treat non-tool markers as tool calls", () => {
        expect(stream("[reasoning] alpha → beta")).toBe("[reasoning] alpha → beta");
    });

    test("renders Read tool calls as tool name plus compact path", () => {
        const home = process.env.HOME ?? "/Users/williamcory";
        const input = `[tool] Read: {"file_path":"${home}/.claude/projects/session.json","limit":20}`;
        expect(stream(input)).toBe("read ~/.claude/projects/session.json limit=20");
    });
});
