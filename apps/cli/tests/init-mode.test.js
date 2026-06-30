import { expect, test } from "bun:test";
import { resolveInitMode } from "../src/init-command.js";
import { isCI, isAgentHarness } from "../src/util/envDetect.js";

// ---------------------------------------------------------------------------
// resolveInitMode: non-interactive signals
// ---------------------------------------------------------------------------

/** Minimal c object that looks like an interactive human terminal. */
function humanCtx(overrides = {}) {
    return {
        options: { json: false, yes: false, nonInteractive: false },
        formatExplicit: false,
        ...overrides,
    };
}

/** Clean env with no CI / agent / interactive-escape signals. */
function cleanEnv(overrides = {}) {
    return {
        TERM: "xterm-256color",
        ...overrides,
    };
}

// -- explicit flags --

test("resolveInitMode: --json flag forces non-interactive", () => {
    const c = humanCtx({ options: { json: true, yes: false, nonInteractive: false } });
    expect(resolveInitMode(c, cleanEnv())).toBe("non-interactive");
});

test("resolveInitMode: formatExplicit forces non-interactive", () => {
    const c = humanCtx({ formatExplicit: true });
    expect(resolveInitMode(c, cleanEnv())).toBe("non-interactive");
});

test("resolveInitMode: --yes flag forces non-interactive", () => {
    const c = humanCtx({ options: { json: false, yes: true, nonInteractive: false } });
    expect(resolveInitMode(c, cleanEnv())).toBe("non-interactive");
});

test("resolveInitMode: --non-interactive flag forces non-interactive", () => {
    const c = humanCtx({ options: { json: false, yes: false, nonInteractive: true } });
    expect(resolveInitMode(c, cleanEnv())).toBe("non-interactive");
});

// -- env vars --

test("resolveInitMode: SMITHERS_NONINTERACTIVE=1 forces non-interactive", () => {
    expect(resolveInitMode(humanCtx(), cleanEnv({ SMITHERS_NONINTERACTIVE: "1" }))).toBe("non-interactive");
});

test("resolveInitMode: SMITHERS_YES=1 forces non-interactive", () => {
    expect(resolveInitMode(humanCtx(), cleanEnv({ SMITHERS_YES: "1" }))).toBe("non-interactive");
});

test("resolveInitMode: TERM=dumb forces non-interactive", () => {
    expect(resolveInitMode(humanCtx(), cleanEnv({ TERM: "dumb" }))).toBe("non-interactive");
});

// -- CI environments --

test("resolveInitMode: CI=true forces non-interactive", () => {
    expect(resolveInitMode(humanCtx(), cleanEnv({ CI: "true" }))).toBe("non-interactive");
});

test("resolveInitMode: GITHUB_ACTIONS=true forces non-interactive", () => {
    expect(resolveInitMode(humanCtx(), cleanEnv({ GITHUB_ACTIONS: "true" }))).toBe("non-interactive");
});

test("resolveInitMode: GITLAB_CI=true forces non-interactive", () => {
    expect(resolveInitMode(humanCtx(), cleanEnv({ GITLAB_CI: "true" }))).toBe("non-interactive");
});

test("resolveInitMode: BUILDKITE=true forces non-interactive", () => {
    expect(resolveInitMode(humanCtx(), cleanEnv({ BUILDKITE: "true" }))).toBe("non-interactive");
});

test("resolveInitMode: CIRCLECI=true forces non-interactive", () => {
    expect(resolveInitMode(humanCtx(), cleanEnv({ CIRCLECI: "true" }))).toBe("non-interactive");
});

test("resolveInitMode: TF_BUILD=True forces non-interactive (Azure Pipelines)", () => {
    expect(resolveInitMode(humanCtx(), cleanEnv({ TF_BUILD: "True" }))).toBe("non-interactive");
});

// -- agent harnesses --

test("resolveInitMode: CLAUDECODE=1 forces non-interactive", () => {
    expect(resolveInitMode(humanCtx(), cleanEnv({ CLAUDECODE: "1" }))).toBe("non-interactive");
});

test("resolveInitMode: CLAUDE_CODE_ENTRYPOINT=cli forces non-interactive", () => {
    expect(resolveInitMode(humanCtx(), cleanEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" }))).toBe("non-interactive");
});

// -- piped stdin/stdout (process-level; test via isTTY being false) --

test("resolveInitMode: returns non-interactive when process.stdin is not a TTY", () => {
    // In the test runner stdin is never a TTY, so this should always be non-interactive.
    expect(resolveInitMode(humanCtx(), cleanEnv())).toBe("non-interactive");
});

// ---------------------------------------------------------------------------
// isCI helper
// ---------------------------------------------------------------------------

test("isCI: returns false for empty env", () => {
    expect(isCI({})).toBe(false);
});

test("isCI: returns true for CI=true", () => {
    expect(isCI({ CI: "true" })).toBe(true);
});

test("isCI: returns true for GITHUB_ACTIONS", () => {
    expect(isCI({ GITHUB_ACTIONS: "true" })).toBe(true);
});

test("isCI: returns true for BUILDKITE", () => {
    expect(isCI({ BUILDKITE: "true" })).toBe(true);
});

// ---------------------------------------------------------------------------
// isAgentHarness helper
// ---------------------------------------------------------------------------

test("isAgentHarness: returns false for empty env", () => {
    expect(isAgentHarness({})).toBe(false);
});

test("isAgentHarness: returns true for CLAUDECODE", () => {
    expect(isAgentHarness({ CLAUDECODE: "1" })).toBe(true);
});

test("isAgentHarness: returns true for CLAUDE_CODE_ENTRYPOINT", () => {
    expect(isAgentHarness({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(true);
});
