import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAgent } from "../src/index.js";
import { z } from "zod";
import { makeFakeNodeCli, prependPath } from "./fake-cli.js";
const originalPath = process.env.PATH ?? "";
/**
 * @param {string} stdoutScript
 */
async function makeFakeCodex(stdoutScript) {
    const dir = await mkdtemp(join(tmpdir(), "smithers-codex-test-"));
    return makeFakeNodeCli(dir, "codex", stdoutScript);
}
afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.CODEX_ARGS_FILE;
});
describe("Codex CLI agent", () => {
    test("sanitizes z.looseObject outputSchema for Codex structured output when opted in", async () => {
        const agent = new CodexAgent({ nativeStructuredOutput: true });
        const command = await agent.buildCommand({
            prompt: "extract the document",
            cwd: process.cwd(),
            options: {
                outputSchema: z.looseObject({ document: z.string() }),
            },
        });
        try {
            const schemaPath = command.args[command.args.indexOf("--output-schema") + 1];
            const schema = JSON.parse(await readFile(schemaPath, "utf8"));
            expect(schema.type).toBe("object");
            expect(schema.additionalProperties).toBe(false);
            expect(schema.additionalProperties).not.toEqual({});
        }
        finally {
            await command.cleanup?.();
        }
    });
    test("does NOT pass --output-schema for a task schema by default (keeps tool use)", async () => {
        // Native structured output (`--output-schema`) makes Codex refuse tool calls,
        // breaking agentic fix/implement tasks. By default a task-provided schema must
        // NOT reach the CLI — the engine prompt-injects it and Codex stays agentic.
        const agent = new CodexAgent();
        const command = await agent.buildCommand({
            prompt: "fix the bug in the repo",
            cwd: process.cwd(),
            options: {
                outputSchema: z.looseObject({ status: z.string() }),
            },
        });
        try {
            expect(command.args).not.toContain("--output-schema");
            expect(agent.supportsNativeStructuredOutput).toBe(false);
        }
        finally {
            await command.cleanup?.();
        }
    });
    test("resumes an existing session when resumeSession is provided", async () => {
        const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-codex-args-"));
        const argsFile = join(argsFileDir, "args.json");
        const fake = await makeFakeCodex(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.CODEX_ARGS_FILE) fs.writeFileSync(process.env.CODEX_ARGS_FILE, JSON.stringify(args), "utf8");
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex >= 0 && args[outputIndex + 1]) {
  fs.writeFileSync(args[outputIndex + 1], "done", "utf8");
}
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { id: "assistant-1", type: "agent_message", text: "done" }
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            process.env.CODEX_ARGS_FILE = argsFile;
            const agent = new CodexAgent({
                env: { PATH: process.env.PATH },
                sandbox: "danger-full-access",
                dangerouslyBypassApprovalsAndSandbox: true,
                skipGitRepoCheck: true,
            });
            const result = await agent.generate({
                prompt: "continue the work",
                resumeSession: "thread-1",
            });
            expect(result.text).toBe("done");
            const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
            expect(capturedArgs.slice(0, 2)).toEqual(["exec", "resume"]);
            expect(capturedArgs).not.toContain("--sandbox");
            expect(capturedArgs).toContain("--json");
            expect(capturedArgs).toContain("--dangerously-bypass-approvals-and-sandbox");
            expect(capturedArgs).toContain("--skip-git-repo-check");
            const sessionIndex = capturedArgs.indexOf("thread-1");
            expect(sessionIndex).toBeGreaterThan(1);
            expect(capturedArgs.slice(-2)).toEqual(["thread-1", "-"]);
            expect(capturedArgs.indexOf("--json")).toBeLessThan(sessionIndex);
            expect(capturedArgs.indexOf("--output-last-message")).toBeLessThan(sessionIndex);
            expect(capturedArgs.indexOf("--dangerously-bypass-approvals-and-sandbox")).toBeLessThan(sessionIndex);
            expect(capturedArgs.indexOf("--skip-git-repo-check")).toBeLessThan(sessionIndex);
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(argsFileDir, { recursive: true, force: true });
        }
    });
    test("distills the turn.failed message instead of storing codex stderr log noise", async () => {
        // Historically a codex failure persisted the stderr tail
        // ("ERROR codex_models_manager::manager: failed to refresh available
        // models...") as the attempt error while the clean turn.failed message
        // in the stdout stream was discarded.
        const fake = await makeFakeCodex(`
process.stderr.write("2026-06-27T18:45:30.098342Z ERROR codex_models_manager::manager: failed to refresh available models: stream disconnected before completion\\n");
process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected before completion: connection reset by upstream" } }) + "\\n");
process.exit(1);
`);
        try {
            process.env.PATH = prependPath(fake.dir, originalPath);
            const agent = new CodexAgent({ env: { PATH: process.env.PATH } });
            let error;
            try {
                await agent.generate({ messages: [{ role: "user", content: "do the thing" }] });
            }
            catch (err) {
                error = err;
            }
            expect(error).toBeDefined();
            expect(String(error?.message ?? "")).toContain("connection reset by upstream");
            expect(String(error?.message ?? "")).not.toContain("codex_models_manager");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    });
});
