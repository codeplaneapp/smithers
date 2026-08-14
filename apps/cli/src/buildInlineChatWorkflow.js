import React from "react";
import { openInlineWorkflowStore } from "./openInlineWorkflowStore.js";

/** @typedef {"claude-code" | "codex" | "antigravity" | "pi" | "omp" | "kimi" | "amp"} InlineChatEngine */

/**
 * Agent engines that can host an inline auto-hijacked chat task: each has a
 * CLI adapter that records a resumable session AND a native terminal attach in
 * buildHijackLaunchSpec, so `smithers hijack` (or an auto-launched hijack) can
 * drop the user straight into the live session.
 */
export const INLINE_CHAT_ENGINES = /** @type {const} */ ([
  "claude-code",
  "codex",
  "antigravity",
  "pi",
  "omp",
  "kimi",
  "amp",
]);

/** Default bootstrap prompt for `smithers chat create` sessions. */
export const CHAT_CREATE_PROMPT = [
  "Start an interactive chat session with the user and help them directly.",
  "Stay in this conversation until the user is done.",
  "When you are completely finished and want to hand control back to Smithers, return ONLY this raw JSON object with no prose, markdown, or code fence: {}.",
].join("\n\n");

/**
 * @param {InlineChatEngine} engine
 * @param {string} cwd
 */
async function createChatAgent(engine, cwd) {
  switch (engine) {
    case "claude-code": {
      const { ClaudeCodeAgent } = await import("@smthrs/agents/ClaudeCodeAgent");
      return new ClaudeCodeAgent({
        cwd,
        model: "claude-fable-5",
      });
    }
    case "codex": {
      const { CodexAgent } = await import("@smthrs/agents/CodexAgent");
      return new CodexAgent({
        cwd,
        model: "gpt-5.6-luna",
        config: { model_reasoning_effort: "medium" },
        skipGitRepoCheck: true,
      });
    }
    case "antigravity": {
      const { AntigravityAgent } = await import("@smthrs/agents/AntigravityAgent");
      return new AntigravityAgent({
        cwd,
      });
    }
    case "pi": {
      const { PiAgent } = await import("@smthrs/agents/PiAgent");
      return new PiAgent({
        cwd,
      });
    }
    case "omp": {
      const { OmpAgent } = await import("@smthrs/agents/OmpAgent");
      return new OmpAgent({
        cwd,
      });
    }
    case "kimi": {
      const { KimiAgent } = await import("@smthrs/agents/KimiAgent");
      return new KimiAgent({
        cwd,
      });
    }
    case "amp": {
      const { AmpAgent } = await import("@smthrs/agents/AmpAgent");
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
 * @returns {Promise<import("@smthrs/components/SmithersWorkflow").SmithersWorkflow<any>>}
 */
export async function buildInlineChatWorkflow({ engine, cwd, prompt, name = "chat" }) {
  const [{ Workflow, Task }, { z: zod }] = await Promise.all([import("@smthrs/components"), import("zod")]);
  const agent = await createChatAgent(engine, cwd);
  const chatSchema = zod.object({});
  const store = await openInlineWorkflowStore(cwd, { [name]: chatSchema });
  return {
    ...store,
    build: () =>
      React.createElement(
        Workflow,
        { name },
        React.createElement(
          Task,
          {
            id: name,
            output: chatSchema,
            agent,
            hijack: true,
          },
          prompt,
        ),
      ),
    opts: {},
  };
}
