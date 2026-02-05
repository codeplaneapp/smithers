import { randomUUID } from "crypto";
import type { AgentEvent } from "@mariozechner/pi-ai";
import type { AgentStreamEventDTO, AttachmentDTO } from "../../shared/rpc";
import { AppDb } from "../db";
import { ToolRunner } from "../tools";
import { runAgentTurn } from "./runner";

export type AgentServiceOptions = {
  db: AppDb;
  workspaceRoot: string;
  emit: (event: AgentStreamEventDTO) => void;
  smithers?: {
    runWorkflow: (params: { workflowPath: string; input: any; attachToSessionId?: string }) => Promise<string>;
  };
};

export class AgentService {
  private db: AppDb;
  private workspaceRoot: string;
  private emit: (event: AgentStreamEventDTO) => void;
  private smithers?: AgentServiceOptions["smithers"];
  private runs = new Map<string, AbortController>();

  constructor(opts: AgentServiceOptions) {
    this.db = opts.db;
    this.workspaceRoot = opts.workspaceRoot;
    this.emit = opts.emit;
    this.smithers = opts.smithers;
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
    const runId = randomUUID();
    const abort = new AbortController();
    this.runs.set(runId, abort);

    const toolRunner = new ToolRunner({ rootDir: this.workspaceRoot });

    try {
      await this.maybeTriggerWorkflow(params.sessionId, params.text);
    } catch {
      // ignore workflow trigger errors so chat can continue
    }

    const generator = runAgentTurn({
      text: params.text,
      attachments: params.attachments ?? [],
      toolRunner,
      signal: abort.signal,
    });

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

  private async consumeEvents(opts: {
    sessionId: string;
    runId: string;
    generator: AsyncIterable<AgentEvent>;
  }) {
    const { sessionId, runId, generator } = opts;
    const toolMessageIds = new Map<string, string | null>();
    const toolStarts = new Map<string, { args: any; startedAtMs: number }>();

    try {
      for await (const event of generator) {
        this.emit({ runId, event });
        if (event.type === "message_end") {
          const messageId = this.db.insertMessage({
            sessionId,
            role: event.message.role,
            content: event.message as any,
            runId,
          });
          if (event.message.role === "assistant") {
            for (const content of event.message.content) {
              if (content.type === "toolCall") {
                toolMessageIds.set(content.id, messageId);
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
    const match = text.match(/@workflow\\(([^)]+)\\)/i);
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
