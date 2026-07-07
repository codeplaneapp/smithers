import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeAgent } from "../src/index.js";
import { makeFakeNodeCli, prependPath } from "./fake-cli.js";
const originalPath = process.env.PATH ?? "";
/**
 * @param {string} stdoutScript
 */
async function makeFakeClaude(stdoutScript) {
    const dir = await mkdtemp(join(tmpdir(), "smithers-claude-test-"));
    return makeFakeNodeCli(dir, "claude", stdoutScript);
}
afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.CLAUDE_ARGS_FILE;
});
describe("Claude Code CLI agent", () => {
    test("adds --verbose when using stream-json output", async () => {
        const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-claude-args-"));
        const argsFile = join(argsFileDir, "args.json");
        const fake = await makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.CLAUDE_ARGS_FILE) fs.writeFileSync(process.env.CLAUDE_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write(JSON.stringify({
  type: "turn_end",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] }
}) + "\\n");
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            process.env.CLAUDE_ARGS_FILE = argsFile;
            const agent = new ClaudeCodeAgent({
                model: "claude-opus-4-7",
                env: { PATH: process.env.PATH },
            });
            const result = await agent.generate({
                messages: [{ role: "user", content: "Ping?" }],
            });
            expect(result.text).toBe("done");
            const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
            expect(capturedArgs).toContain("--print");
            expect(capturedArgs).toContain("--output-format");
            expect(capturedArgs).toContain("stream-json");
            expect(capturedArgs).toContain("--verbose");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(argsFileDir, { recursive: true, force: true });
        }
    });
    test("adds --continue when continueSession is set, and not otherwise", async () => {
        const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-claude-args-"));
        const argsFile = join(argsFileDir, "args.json");
        const fake = await makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.CLAUDE_ARGS_FILE) fs.writeFileSync(process.env.CLAUDE_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write("done\\n");
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            process.env.CLAUDE_ARGS_FILE = argsFile;
            const agent = new ClaudeCodeAgent({ model: "claude-opus-4-7", outputFormat: "text", env: { PATH: process.env.PATH } });
            await agent.generate({ messages: [{ role: "user", content: "Ping?" }], continueSession: true });
            expect(JSON.parse(await readFile(argsFile, "utf8"))).toContain("--continue");
            await agent.generate({ messages: [{ role: "user", content: "Ping?" }] });
            expect(JSON.parse(await readFile(argsFile, "utf8"))).not.toContain("--continue");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(argsFileDir, { recursive: true, force: true });
        }
    });
    test("injects a PostToolUse durability hook + socket env when durabilitySocket is set", async () => {
        const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-claude-args-"));
        const argsFile = join(argsFileDir, "args.json");
        const fake = await makeFakeClaude(`
const fs = require("node:fs");
fs.writeFileSync(process.env.CLAUDE_ARGS_FILE, JSON.stringify({ args: process.argv.slice(2), sock: process.env.SMITHERS_SNAPSHOT_SOCK || null }), "utf8");
process.stdout.write("done\\n");
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            process.env.CLAUDE_ARGS_FILE = argsFile;
            const agent = new ClaudeCodeAgent({ model: "claude-opus-4-7", outputFormat: "text", env: { PATH: process.env.PATH } });
            await agent.generate({ messages: [{ role: "user", content: "Ping?" }], durabilitySocket: "/tmp/sm-snap-test.sock" });
            const captured = JSON.parse(await readFile(argsFile, "utf8"));
            const si = captured.args.indexOf("--settings");
            expect(si).toBeGreaterThanOrEqual(0);
            const settings = JSON.parse(captured.args[si + 1]);
            expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("smithers snapshot-hook");
            expect(settings.hooks.PostToolUse[0].matcher).toContain("Edit");
            expect(captured.sock).toBe("/tmp/sm-snap-test.sock");

            await agent.generate({ messages: [{ role: "user", content: "Ping?" }] });
            const captured2 = JSON.parse(await readFile(argsFile, "utf8"));
            expect(captured2.args).not.toContain("--settings");
            expect(captured2.sock).toBeNull();
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(argsFileDir, { recursive: true, force: true });
        }
    });
    test("classifies a raw (non-JSON) session-limit banner on stdout as a quota error", async () => {
        // Claude/Fable print the session-limit banner as a RAW stdout line (not
        // stream-json) and exit 0. It must become AGENT_QUOTA_EXCEEDED so the run
        // parks as a resumable quota wait instead of failing output validation.
        const fake = await makeFakeClaude(`
process.stdout.write("You've hit your session limit \\u00b7 resets 5:50pm (America/New_York)\\n");
process.exit(0);
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            const agent = new ClaudeCodeAgent({
                model: "claude-fable-5",
                env: { PATH: process.env.PATH },
            });
            let error;
            try {
                await agent.generate({ messages: [{ role: "user", content: "audit this" }] });
            }
            catch (err) {
                error = err;
            }
            expect(error).toBeDefined();
            expect(error?.code).toBe("AGENT_QUOTA_EXCEEDED");
            expect(error?.details?.failureQuota).toBe(true);
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    });
    test("does not misclassify a successful run whose answer mentions rate-limit prose as a quota error", async () => {
        // A successful run (is_error:false, subtype:success, exit 0) whose model
        // output merely *mentions* quota/rate-limit prose must NOT be parked as a
        // quota wait. The banner interpreter is gated by the narrow
        // isClaudeLimitBanner matcher, not the broad quota classifier.
        const answer = "The endpoint returns 429 rate limit exceeded when too many requests arrive";
        const fake = await makeFakeClaude(`
process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(answer)} }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(answer)} }) + "\\n");
process.exit(0);
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            const agent = new ClaudeCodeAgent({
                model: "claude-fable-5",
                env: { PATH: process.env.PATH },
            });
            const result = await agent.generate({ messages: [{ role: "user", content: "audit this" }] });
            expect(result.text).toContain("rate limit exceeded");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    });
    test("classifies a stream-json assistant-text session-limit banner as a quota error", async () => {
        const banner = "You've hit your session limit \\u00b7 resets 5:50pm (America/New_York)";
        const fake = await makeFakeClaude(`
process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "${banner}" }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "" }) + "\\n");
process.exit(0);
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            const agent = new ClaudeCodeAgent({ model: "claude-fable-5", env: { PATH: process.env.PATH } });
            let error;
            try {
                await agent.generate({ messages: [{ role: "user", content: "audit this" }] });
            }
            catch (err) {
                error = err;
            }
            expect(error).toBeDefined();
            expect(error?.code).toBe("AGENT_QUOTA_EXCEEDED");
            expect(error?.details?.failureQuota).toBe(true);
            expect(typeof error?.details?.quotaResetAtMs).toBe("number");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    });
    test("classifies a session-limit banner in the stream-json result payload as a quota error", async () => {
        const banner = "You're out of usage credits. Run /usage-credits to keep using Fable 5";
        const fake = await makeFakeClaude(`
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(banner)} }) + "\\n");
process.exit(0);
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            const agent = new ClaudeCodeAgent({ model: "claude-fable-5", env: { PATH: process.env.PATH } });
            let error;
            try {
                await agent.generate({ messages: [{ role: "user", content: "audit this" }] });
            }
            catch (err) {
                error = err;
            }
            expect(error).toBeDefined();
            expect(error?.code).toBe("AGENT_QUOTA_EXCEEDED");
            expect(error?.details?.failureQuota).toBe(true);
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    });
    test("classifies a rejected rate_limit_event (out_of_credits) as a quota error with a reset time", async () => {
        // Claude emits a stream-json rate_limit_event when the subscription
        // window rejects the request. Historically this line was ignored, the
        // run failed on empty output, and the raw JSON tail was stored as the
        // error instead of parking the run as waiting-quota.
        const resetsAt = Math.floor(Date.now() / 1000) + 1800;
        const fake = await makeFakeClaude(`
process.stdout.write(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: ${resetsAt}, rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false } }) + "\\n");
process.exit(1);
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            const agent = new ClaudeCodeAgent({ model: "claude-fable-5", env: { PATH: process.env.PATH } });
            let error;
            try {
                await agent.generate({ messages: [{ role: "user", content: "audit this" }] });
            }
            catch (err) {
                error = err;
            }
            expect(error).toBeDefined();
            expect(error?.code).toBe("AGENT_QUOTA_EXCEEDED");
            expect(error?.details?.failureQuota).toBe(true);
            const resetMs = error?.details?.quotaResetAtMs;
            expect(typeof resetMs).toBe("number");
            expect(resetMs).toBeGreaterThan(Date.now());
            expect(resetMs).toBeLessThanOrEqual(resetsAt * 1000 + 60_000);
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    });
    test("classifies a rejected rate_limit_event on a clean exit (code 0) as a quota error", async () => {
        const fake = await makeFakeClaude(`
process.stdout.write(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "out_of_credits" } }) + "\\n");
process.exit(0);
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            const agent = new ClaudeCodeAgent({ model: "claude-fable-5", env: { PATH: process.env.PATH } });
            let error;
            try {
                await agent.generate({ messages: [{ role: "user", content: "audit this" }] });
            }
            catch (err) {
                error = err;
            }
            expect(error).toBeDefined();
            expect(error?.code).toBe("AGENT_QUOTA_EXCEEDED");
            expect(error?.details?.failureQuota).toBe(true);
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    });
    test("does not treat an allowed rate_limit_event as an error", async () => {
        const fake = await makeFakeClaude(`
process.stdout.write(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hello" }) + "\\n");
process.exit(0);
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            const agent = new ClaudeCodeAgent({ model: "claude-fable-5", env: { PATH: process.env.PATH } });
            const result = await agent.generate({ messages: [{ role: "user", content: "hi" }] });
            expect(result.text).toBe("hello");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    });
    test("stores the distilled stream error, not the raw stdout tail, when claude exits nonzero", async () => {
        // Historically a failed claude run persisted the last stdout line (the
        // system/init JSON) as the attempt error. The interpreter's distilled
        // completed-event error must win over the raw tail.
        const fake = await makeFakeClaude(`
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", cwd: "/tmp", session_id: "abc", tools: ["Bash"] }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "error", is_error: true, error: "API Error: 500 upstream connect error" }) + "\\n");
process.exit(1);
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            const agent = new ClaudeCodeAgent({ model: "claude-fable-5", env: { PATH: process.env.PATH } });
            let error;
            try {
                await agent.generate({ messages: [{ role: "user", content: "audit this" }] });
            }
            catch (err) {
                error = err;
            }
            expect(error).toBeDefined();
            expect(String(error?.message ?? "")).toContain("500 upstream connect error");
            expect(String(error?.message ?? "")).not.toContain('"subtype":"init"');
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    });
    test("does not add --verbose for text output by default", async () => {
        const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-claude-args-"));
        const argsFile = join(argsFileDir, "args.json");
        const fake = await makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.CLAUDE_ARGS_FILE) fs.writeFileSync(process.env.CLAUDE_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write("done\\n");
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            process.env.CLAUDE_ARGS_FILE = argsFile;
            const agent = new ClaudeCodeAgent({
                model: "claude-opus-4-7",
                outputFormat: "text",
                env: { PATH: process.env.PATH },
            });
            const result = await agent.generate({
                messages: [{ role: "user", content: "Ping?" }],
            });
            expect(result.text).toBe("done");
            const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
            expect(capturedArgs).toContain("--output-format");
            expect(capturedArgs).toContain("text");
            expect(capturedArgs).not.toContain("--verbose");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(argsFileDir, { recursive: true, force: true });
        }
    });
});
