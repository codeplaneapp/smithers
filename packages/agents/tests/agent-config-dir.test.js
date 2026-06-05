import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AntigravityAgent, ClaudeCodeAgent, CodexAgent, GeminiAgent } from "../src/index.js";

const originalPath = process.env.PATH ?? "";
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
    process.env.PATH = originalPath;
    if (originalAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
    }
    else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
    delete process.env.SMITHERS_ENV_DUMP_FILE;
});

/**
 * Writes a fake CLI binary that captures its invocation environment to
 * SMITHERS_ENV_DUMP_FILE and emits the right "happy path" stdout for the
 * agent's parser so the test focuses on env vars, not CLI semantics.
 *
 * @param {string} name
 * @param {string} stdoutEmitter  inline JS that writes a single chunk to stdout
 */
async function makeFakeCliWithEnvDump(name, stdoutEmitter) {
    const dir = await mkdtemp(join(tmpdir(), `smithers-${name}-test-`));
    const binPath = join(dir, name);
    const script = [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "if (process.env.SMITHERS_ENV_DUMP_FILE) {",
        "  fs.writeFileSync(process.env.SMITHERS_ENV_DUMP_FILE, JSON.stringify({",
        "    ARGS: process.argv.slice(2),",
        "    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,",
        "    CODEX_HOME: process.env.CODEX_HOME ?? null,",
        "    GEMINI_DIR: process.env.GEMINI_DIR ?? null,",
        "    KIMI_SHARE_DIR: process.env.KIMI_SHARE_DIR ?? null,",
        "    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,",
        "    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,",
        "    GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null,",
        '  }), "utf8");',
        "}",
        stdoutEmitter,
        "",
    ].join("\n");
    await writeFile(binPath, script, "utf8");
    await chmod(binPath, 0o755);
    return { dir, binPath };
}

async function readEnvDump(dumpFile) {
    return JSON.parse(await readFile(dumpFile, "utf8"));
}

describe("ClaudeCodeAgent configDir/apiKey", () => {
    test("configDir is forwarded as CLAUDE_CONFIG_DIR on the spawned process", async () => {
        const dumpDir = await mkdtemp(join(tmpdir(), "smithers-env-dump-"));
        const dumpFile = join(dumpDir, "env.json");
        const fake = await makeFakeCliWithEnvDump(
            "claude",
            'process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\\n");',
        );
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            process.env.SMITHERS_ENV_DUMP_FILE = dumpFile;
            const agent = new ClaudeCodeAgent({
                model: "claude-opus-4-7",
                configDir: "/tmp/smithers-test-claude-work",
                env: { PATH: process.env.PATH, SMITHERS_ENV_DUMP_FILE: dumpFile },
            });
            await agent.generate({ messages: [{ role: "user", content: "ping" }] });
            const dumped = await readEnvDump(dumpFile);
            expect(dumped.CLAUDE_CONFIG_DIR).toBe("/tmp/smithers-test-claude-work");
            // Subscription path: ANTHROPIC_API_KEY must remain unset.
            expect(dumped.ANTHROPIC_API_KEY === null || dumped.ANTHROPIC_API_KEY === "").toBe(true);
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(dumpDir, { recursive: true, force: true });
        }
    });

    test("apiKey opts caller into ANTHROPIC_API_KEY without it being unset", async () => {
        const dumpDir = await mkdtemp(join(tmpdir(), "smithers-env-dump-"));
        const dumpFile = join(dumpDir, "env.json");
        const fake = await makeFakeCliWithEnvDump(
            "claude",
            'process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\\n");',
        );
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            process.env.SMITHERS_ENV_DUMP_FILE = dumpFile;
            // Pre-existing ANTHROPIC_API_KEY in parent env: with apiKey set we
            // must NOT clobber it back to "".
            process.env.ANTHROPIC_API_KEY = "sk-ant-from-parent";
            const agent = new ClaudeCodeAgent({
                model: "claude-opus-4-7",
                apiKey: "sk-ant-explicit",
                env: { PATH: process.env.PATH, SMITHERS_ENV_DUMP_FILE: dumpFile },
            });
            await agent.generate({ messages: [{ role: "user", content: "ping" }] });
            const dumped = await readEnvDump(dumpFile);
            expect(dumped.ANTHROPIC_API_KEY).toBe("sk-ant-explicit");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(dumpDir, { recursive: true, force: true });
        }
    });
});

describe("CodexAgent configDir/apiKey", () => {
    test("configDir → CODEX_HOME, apiKey → OPENAI_API_KEY", async () => {
        const dumpDir = await mkdtemp(join(tmpdir(), "smithers-env-dump-"));
        const dumpFile = join(dumpDir, "env.json");
        const fake = await makeFakeCliWithEnvDump(
            "codex",
            [
                "const args = process.argv.slice(2);",
                'const i = args.indexOf("--output-last-message");',
                "if (i >= 0 && args[i + 1]) {",
                '  fs.writeFileSync(args[i + 1], "```json\\n{\\"summary\\":\\"ok\\"}\\n```\\n", "utf8");',
                "}",
                'process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");',
            ].join("\n"),
        );
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            process.env.SMITHERS_ENV_DUMP_FILE = dumpFile;
            const agent = new CodexAgent({
                model: "gpt-5.4-codex",
                skipGitRepoCheck: true,
                configDir: "/tmp/smithers-test-codex-work",
                apiKey: "sk-openai-test",
                env: { PATH: process.env.PATH, SMITHERS_ENV_DUMP_FILE: dumpFile },
            });
            await agent.generate({ messages: [{ role: "user", content: "ping" }] });
            const dumped = await readEnvDump(dumpFile);
            expect(dumped.CODEX_HOME).toBe("/tmp/smithers-test-codex-work");
            expect(dumped.OPENAI_API_KEY).toBe("sk-openai-test");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(dumpDir, { recursive: true, force: true });
        }
    });
});

describe("GeminiAgent configDir/apiKey", () => {
    test("configDir → GEMINI_DIR, apiKey → GEMINI_API_KEY", async () => {
        const dumpDir = await mkdtemp(join(tmpdir(), "smithers-env-dump-"));
        const dumpFile = join(dumpDir, "env.json");
        const fake = await makeFakeCliWithEnvDump(
            "gemini",
            'process.stdout.write(JSON.stringify({ text: "```json\\n{\\"summary\\":\\"ok\\"}\\n```\\n" }) + "\\n");',
        );
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            process.env.SMITHERS_ENV_DUMP_FILE = dumpFile;
            const agent = new GeminiAgent({
                model: "gemini-3.1-pro-preview",
                configDir: "/tmp/smithers-test-gemini-work",
                apiKey: "gemini-test-key",
                env: { PATH: process.env.PATH, SMITHERS_ENV_DUMP_FILE: dumpFile },
            });
            await agent.generate({ messages: [{ role: "user", content: "ping" }] });
            const dumped = await readEnvDump(dumpFile);
            expect(dumped.GEMINI_DIR).toBe("/tmp/smithers-test-gemini-work");
            expect(dumped.GEMINI_API_KEY).toBe("gemini-test-key");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(dumpDir, { recursive: true, force: true });
        }
    });
});

describe("AntigravityAgent configDir/apiKey", () => {
    test("configDir -> --gemini_dir, apiKey -> GEMINI_API_KEY", async () => {
        const dumpDir = await mkdtemp(join(tmpdir(), "smithers-env-dump-"));
        const dumpFile = join(dumpDir, "env.json");
        const fake = await makeFakeCliWithEnvDump(
            "agy",
            'process.stdout.write(JSON.stringify({ text: "```json\\n{\\"summary\\":\\"ok\\"}\\n```\\n" }) + "\\n");',
        );
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            process.env.SMITHERS_ENV_DUMP_FILE = dumpFile;
            const agent = new AntigravityAgent({
                configDir: "/tmp/smithers-test-antigravity-work",
                apiKey: "antigravity-test-key",
                env: { PATH: process.env.PATH, SMITHERS_ENV_DUMP_FILE: dumpFile },
            });
            await agent.generate({ messages: [{ role: "user", content: "ping" }] });
            const dumped = await readEnvDump(dumpFile);
            expect(dumped.ARGS).toContain("--gemini_dir");
            expect(dumped.ARGS).toContain("/tmp/smithers-test-antigravity-work");
            expect(dumped.GEMINI_DIR).toBe("/tmp/smithers-test-antigravity-work");
            expect(dumped.GEMINI_API_KEY).toBe("antigravity-test-key");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(dumpDir, { recursive: true, force: true });
        }
    });

    // Regression for #202: the Antigravity CLI (`agy`) rejects unknown flags and
    // exits immediately, so the args must match the real CLI surface.
    test("emits only flags the agy CLI actually accepts", async () => {
        const dumpDir = await mkdtemp(join(tmpdir(), "smithers-env-dump-"));
        const dumpFile = join(dumpDir, "env.json");
        const fake = await makeFakeCliWithEnvDump(
            "agy",
            'process.stdout.write(JSON.stringify({ text: "```json\\n{\\"summary\\":\\"ok\\"}\\n```\\n" }) + "\\n");',
        );
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            process.env.SMITHERS_ENV_DUMP_FILE = dumpFile;
            const agent = new AntigravityAgent({
                resume: "d1d8a55b-cc27-4dd4-bc62-2f73015960d2",
                includeDirectories: ["/tmp/extra-root"],
                env: { PATH: process.env.PATH, SMITHERS_ENV_DUMP_FILE: dumpFile },
            });
            await agent.generate({ messages: [{ role: "user", content: "ping" }] });
            const args = (await readEnvDump(dumpFile)).ARGS;

            // Corrected flags. `resume` is mapped to `--conversation <id>`.
            expect(args).toContain("--conversation");
            expect(args).toContain("d1d8a55b-cc27-4dd4-bc62-2f73015960d2");
            expect(args).toContain("--add-dir");
            expect(args).toContain("/tmp/extra-root");

            // Flags that do not exist on `agy` must never be passed.
            for (const dead of [
                "--output-format",
                "--include-directories",
                "--resume",
                "--screen-reader",
                "--debug",
                "--extensions",
                "--list-extensions",
                "--list-sessions",
                "--delete-session",
            ]) {
                expect(args).not.toContain(dead);
            }
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(dumpDir, { recursive: true, force: true });
        }
    });
});
