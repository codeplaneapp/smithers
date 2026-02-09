import { randomUUID } from "crypto";
import type { AgentEvent, Message } from "@mariozechner/pi-ai";
import type { AgentSettings, AgentStreamEventDTO, AttachmentDTO } from "@smithers/shared";
import { AppDb } from "../db";
import { ToolRunner } from "../tools";
import { SecretStore } from "../secrets";
import { runAgentTurn, type CustomToolRegistry, type AppCapabilities } from "./runner";

export type AgentServiceOptions = {
  db: AppDb;
  workspaceRoot: string;
  emit: (event: AgentStreamEventDTO) => void;
  secretStore?: SecretStore;
  toolRegistry?: CustomToolRegistry;
  onWorkspaceDirty?: () => void;
  smithers?: {
    runWorkflow: (params: { workflowPath: string; input: any; attachToSessionId?: string }) => Promise<string>;
  };
  listWorkflows?: () => Promise<Array<{ path: string; name?: string; description?: string }>>;
  listRuns?: (status?: string) => Promise<any[]>;
};

export class AgentService {
  private db: AppDb;
  private workspaceRoot: string;
  private emit: (event: AgentStreamEventDTO) => void;
  private smithers?: AgentServiceOptions["smithers"];
  private secretStore?: SecretStore;
  private toolRegistry?: CustomToolRegistry;
  private onWorkspaceDirty?: () => void;
  private listWorkflowsFn?: AgentServiceOptions["listWorkflows"];
  private listRunsFn?: AgentServiceOptions["listRuns"];
  private runs = new Map<string, AbortController>();

  constructor(opts: AgentServiceOptions) {
    this.db = opts.db;
    this.workspaceRoot = opts.workspaceRoot;
    this.emit = opts.emit;
    this.smithers = opts.smithers;
    this.secretStore = opts.secretStore;
    this.toolRegistry = opts.toolRegistry;
    this.listWorkflowsFn = opts.listWorkflows;
    this.listRunsFn = opts.listRuns;
    this.onWorkspaceDirty = opts.onWorkspaceDirty;
  }

  listChatSessions() {
    return this.db.listSessions();
  }

  createChatSession(title?: string) {
    return this.db.createSession(title);
  }

  getChatSession(sessionId: string) {
    return this.db.getSession(sessionId);
  }

  setWorkspaceRoot(root: string) {
    this.workspaceRoot = root;
  }

  async sendChatMessage(params: {
    sessionId: string;
    text: string;
    attachments?: AttachmentDTO[];
  }): Promise<string> {
    console.log("[AgentService] sendChatMessage called:", { sessionId: params.sessionId, text: params.text });
    const runId = randomUUID();
    const abort = new AbortController();
    this.runs.set(runId, abort);

    const settings = this.db.getSettings();
    const allowNetwork = Boolean(settings.smithers?.allowNetwork);
    const toolRunner = new ToolRunner({ rootDir: this.workspaceRoot, allowNetwork });
    const history = this.db
      .listSessionMessages(params.sessionId, 32)
      .filter((msg) => (msg as any)?.role === "user" || (msg as any)?.role === "assistant") as Message[];
    const agentSettings = settings.agent as AgentSettings;
    const openaiKey = this.secretStore ? await this.secretStore.get("openai.apiKey") : null;
    const anthropicKey = this.secretStore ? await this.secretStore.get("anthropic.apiKey") : null;

    try {
      await this.maybeTriggerWorkflow(params.sessionId, params.text);
    } catch {
      // ignore workflow trigger errors so chat can continue
    }

    const appCapabilities: AppCapabilities | undefined =
      this.smithers
        ? {
            listWorkflows: this.listWorkflowsFn ?? (async () => []),
            runWorkflow: (p) => this.smithers!.runWorkflow(p),
            getSettings: () => this.db.getSettings(),
            setSettings: (patch) => this.db.setSettings(patch),
            listRuns: this.listRunsFn ?? (async () => []),
          }
        : undefined;

    const generator = runAgentTurn({
      text: params.text,
      attachments: params.attachments ?? [],
      toolRunner,
      history,
      settings: agentSettings,
      secrets: {
        openaiApiKey: openaiKey ?? process.env.OPENAI_API_KEY ?? null,
        anthropicApiKey: anthropicKey ?? process.env.ANTHROPIC_API_KEY ?? null,
      },
      customTools: this.toolRegistry,
      appCapabilities,
      signal: abort.signal,
    });

    console.log("[AgentService] Starting event consumption for runId:", runId);
    void this.consumeEvents({
      sessionId: params.sessionId,
      runId,
      generator,
    });

    return runId;
  }

  abortRun(runId: string) {
    const controller = this.runs.get(runId);
    if (controller) {
      controller.abort();
      this.runs.delete(runId);
    }
  }

  abortAllRuns() {
    for (const [runId, controller] of this.runs.entries()) {
      controller.abort();
      this.runs.delete(runId);
    }
  }

  private async consumeEvents(opts: {
    sessionId: string;
    runId: string;
    generator: AsyncIterable<AgentEvent>;
  }) {
    const { sessionId, runId, generator } = opts;
    const toolMessageIds = new Map<string, string | null>();
    const toolStarts = new Map<string, { args: any; startedAtMs: number }>();
    const toolMutations = new Set(["write", "edit", "bash"]);

    console.log("[AgentService] consumeEvents started for runId:", runId);
    try {
      for await (const event of generator) {
        console.log("[AgentService] Emitting event:", event.type, "for runId:", runId);
        this.emit({ runId, event });
        if (event.type === "message_end") {
          const inserted = this.db.insertMessage({
            sessionId,
            role: event.message.role,
            content: event.message as any,
            runId,
          });
          if (event.message.role === "assistant") {
            for (const content of event.message.content) {
              if (content.type === "toolCall") {
                toolMessageIds.set(content.id, inserted.messageId);
              }
            }
          }
        }
        if (event.type === "tool_execution_start") {
          toolStarts.set(event.toolCallId, { args: event.args, startedAtMs: Date.now() });
        }
        if (event.type === "tool_execution_end") {
          const start = toolStarts.get(event.toolCallId);
          this.db.insertToolCall({
            toolCallId: event.toolCallId,
            sessionId,
            runId,
            messageId: toolMessageIds.get(event.toolCallId) ?? null,
            toolName: event.toolName,
            input: start?.args ?? null,
            output: event.result,
            status: event.isError ? "error" : "success",
            startedAtMs: start?.startedAtMs ?? Date.now(),
            finishedAtMs: Date.now(),
          });
          toolStarts.delete(event.toolCallId);
          if (toolMutations.has(event.toolName.toLowerCase())) {
            this.onWorkspaceDirty?.();
          }
        }
      }
    } catch (err) {
      this.emit({
        runId,
        event: {
          type: "agent_end",
          messages: [],
        },
      });
    } finally {
      this.runs.delete(runId);
    }
  }

  private async maybeTriggerWorkflow(sessionId: string, text: string) {
    if (!this.smithers) return;
    const match =
      text.match(/@workflow\(([^)]+)\)/i) ??
      text.match(/\brun\s+workflow\s+([^\s]+\.tsx)\b/i) ??
      text.match(/\brun\s+([^\s]+\.tsx)\b/i);
    if (!match) return;
    const workflowPath = match[1].trim();
    if (!workflowPath) return;
    let input: any = {};
    const inputMatch = text.match(/input\\s*=\\s*(\\{[\\s\\S]*\\})/i);
    if (inputMatch) {
      try {
        input = JSON.parse(inputMatch[1]);
      } catch {
        input = {};
      }
    }
    await this.smithers.runWorkflow({ workflowPath, input, attachToSessionId: sessionId });
  }
}
