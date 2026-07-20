import { resolve } from "node:path";
import React from "react";
import { SmithersError } from "@smithers-orchestrator/errors";
import { readBackendMarkerForCwd } from "./readBackendMarkerForCwd.js";

/** @typedef {"claude-code" | "codex" | "antigravity" | "pi" | "kimi" | "amp"} InlineChatEngine */

/**
 * Agent engines that can host an inline auto-hijacked chat task: each has a
 * CLI adapter that records a resumable session AND a native terminal attach in
 * buildHijackLaunchSpec, so `smithers hijack` (or an auto-launched hijack) can
 * drop the user straight into the live session.
 */
export const INLINE_CHAT_ENGINES = /** @type {const} */ (["claude-code", "codex", "antigravity", "pi", "kimi", "amp"]);

/** Default bootstrap prompt for `smithers chat create` sessions. */
export const CHAT_CREATE_PROMPT = [
    "Start an interactive chat session with the user and help them directly.",
    "Stay in this conversation until the user is done.",
    'When you are completely finished and want to hand control back to Smithers, return ONLY this raw JSON object with no prose, markdown, or code fence: {}.',
].join("\n\n");

/**
 * @param {InlineChatEngine} engine
 * @param {string} cwd
 */
async function createChatAgent(engine, cwd) {
    switch (engine) {
        case "claude-code": {
            const { ClaudeCodeAgent } = await import("@smithers-orchestrator/agents/ClaudeCodeAgent");
            return new ClaudeCodeAgent({
                cwd,
                model: "claude-fable-5",
            });
        }
        case "codex": {
            const { CodexAgent } = await import("@smithers-orchestrator/agents/CodexAgent");
            return new CodexAgent({
                cwd,
                model: "gpt-5.6-luna",
                config: { model_reasoning_effort: "medium" },
                skipGitRepoCheck: true,
            });
        }
        case "antigravity": {
            const { AntigravityAgent } = await import("@smithers-orchestrator/agents/AntigravityAgent");
            return new AntigravityAgent({
                cwd,
            });
        }
        case "pi": {
            const { PiAgent } = await import("@smithers-orchestrator/agents/PiAgent");
            return new PiAgent({
                cwd,
            });
        }
        case "kimi": {
            const { KimiAgent } = await import("@smithers-orchestrator/agents/KimiAgent");
            return new KimiAgent({
                cwd,
            });
        }
        case "amp": {
            const { AmpAgent } = await import("@smithers-orchestrator/agents/AmpAgent");
            return new AmpAgent({
                cwd,
            });
        }
    }
}

/**
 * Build a one-task auto-hijacked inline workflow: the task runs `prompt`
 * against the chosen engine with `hijack: true`, so the engine parks the run
 * with a recorded resumable session the user can attach to. `smithers chat
 * create` and the init tutorial are both thin wrappers over this.
 *
 * @param {{ engine: InlineChatEngine; cwd: string; prompt: string; name?: string }} opts
 *   `name` keys the workflow, its task, and its output table — keep it unique
 *   per surface ("chat", "initTutorial") since output tables are shared by
 *   name across every workflow in a workspace DB.
 * @returns {Promise<import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>>}
 */
export async function buildInlineChatWorkflow({ engine, cwd, prompt, name = "chat" }) {
    const [
        { Database },
        { drizzle },
        { sqliteTable, text },
        { Workflow, Task },
        { zodToTable },
        { syncZodTableSchema },
        { camelToSnake },
        { z: zod },
    ] = await Promise.all([
        import("bun:sqlite"),
        import("drizzle-orm/bun-sqlite"),
        import("drizzle-orm/sqlite-core"),
        import("@smithers-orchestrator/components"),
        import("@smithers-orchestrator/db/zodToTable"),
        import("@smithers-orchestrator/db/zodToCreateTableSQL"),
        import("@smithers-orchestrator/db/utils/camelToSnake"),
        import("zod"),
    ]);
    const agent = await createChatAgent(engine, cwd);
    const chatSchema = zod.object({});
    const inputTable = sqliteTable("input", {
        runId: text("run_id").primaryKey(),
        payload: text("payload", { mode: "json" }).$type(),
    });
    const chatTableName = camelToSnake(name);
    const chatTable = zodToTable(chatTableName, chatSchema);
    // Use the workspace store, not a stray ./smithers.db in whatever
    // subdirectory chat was launched from: same anchor rule as createSmithers,
    // same fail-loud guard for non-sqlite workspaces (this inline workflow is
    // bun:sqlite-only).
    const { findSmithersAnchorDir } = await import("smithers-orchestrator/findSmithersAnchorDir");
    const anchorDir = findSmithersAnchorDir(cwd);
    const workspaceBackend = readBackendMarkerForCwd(cwd);
    if (workspaceBackend && workspaceBackend !== "sqlite") {
        throw new SmithersError("BACKEND_MISMATCH", `This workspace's store is ${workspaceBackend}, but inline chat runs currently support only the sqlite backend. Run it in a sqlite workspace or migrate with \`smithers migrate --to sqlite\`.`, { backend: workspaceBackend });
    }
    const sqlite = new Database(resolve(anchorDir ?? cwd, "smithers.db"));
    sqlite.run("PRAGMA journal_mode = WAL");
    sqlite.run("PRAGMA busy_timeout = 30000");
    sqlite.run("PRAGMA synchronous = NORMAL");
    sqlite.run("PRAGMA locking_mode = NORMAL");
    sqlite.run("PRAGMA foreign_keys = ON");
    sqlite.exec(`CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`);
    syncZodTableSchema(sqlite, chatTableName, chatSchema);
    const db = drizzle(sqlite, { schema: { input: inputTable, [name]: chatTable } });
    const schemaRegistry = new Map([[name, { table: chatTable, zodSchema: chatSchema }]]);
    const zodToKeyName = new Map([[chatSchema, name]]);
    return {
        db,
        build: () => React.createElement(Workflow, { name }, React.createElement(Task, {
            id: name,
            output: chatSchema,
            agent,
            hijack: true,
        }, prompt)),
        opts: {},
        schemaRegistry,
        zodToKeyName,
    };
}
