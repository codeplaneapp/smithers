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
