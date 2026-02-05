import { randomUUID } from "crypto";
import type {
  AgentEvent,
  AssistantMessage,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
import type { AttachmentDTO } from "../../shared/rpc";
import { ToolRunner } from "../tools";

export type AgentRunOptions = {
  text: string;
  attachments?: AttachmentDTO[];
  toolRunner: ToolRunner;
  signal?: AbortSignal;
};

type ToolCommand =
  | { name: "read"; path: string }
  | { name: "write"; path: string; content: string }
  | { name: "edit"; path: string; patch: string }
  | { name: "bash"; command: string };

export async function* runAgentTurn(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
  const now = Date.now();
  const userMessage = buildUserMessage(opts.text, opts.attachments ?? [], now);
  const messages: Message[] = [userMessage];

  yield { type: "agent_start" };
  yield { type: "turn_start" };
  yield { type: "message_start", message: userMessage };
  yield { type: "message_end", message: userMessage };

  if (opts.signal?.aborted) {
    yield { type: "agent_end", messages };
    return;
  }

  const command = parseToolCommand(opts.text);
  if (command) {
    const toolCallId = randomUUID();
    const toolCall: ToolCall = {
      type: "toolCall",
      id: toolCallId,
      name: command.name,
      arguments: toolArgsFromCommand(command),
    };

    const assistantMessage = createAssistantMessage([toolCall]);
    messages.push(assistantMessage);

    yield { type: "message_start", message: assistantMessage };
    yield { type: "message_end", message: assistantMessage };

    yield {
      type: "tool_execution_start",
      toolCallId,
      toolName: command.name,
      args: toolCall.arguments,
    };

    const startedAt = Date.now();
    let toolResult: ToolResultMessage;
    let toolError: unknown = null;

    try {
      const output = await runToolCommand(opts.toolRunner, command);
      toolResult = {
        role: "toolResult",
        toolCallId,
        toolName: command.name,
        content: [{ type: "text", text: output.output }],
        details: output.details,
        isError: false,
        timestamp: Date.now(),
      };
    } catch (err) {
      toolError = err;
      toolResult = {
        role: "toolResult",
        toolCallId,
        toolName: command.name,
        content: [{ type: "text", text: String(err) }],
        details: { error: String(err) },
        isError: true,
        timestamp: Date.now(),
      };
    }

    yield {
      type: "tool_execution_end",
      toolCallId,
      toolName: command.name,
      result: toolResult,
      isError: toolResult.isError,
    };

    messages.push(toolResult);
    yield { type: "message_start", message: toolResult };
    yield { type: "message_end", message: toolResult };

    yield { type: "turn_end", message: assistantMessage, toolResults: [toolResult] };
    yield { type: "agent_end", messages };
    return;
  }

  const assistantText = buildAssistantText(opts.text);
  const { finalMessage, events } = streamAssistantMessage(assistantText);
  for (const event of events) {
    yield event;
    if (opts.signal?.aborted) {
      yield { type: "agent_end", messages };
      return;
    }
  }

  messages.push(finalMessage);
  yield { type: "turn_end", message: finalMessage, toolResults: [] };
  yield { type: "agent_end", messages };
}

function buildUserMessage(text: string, attachments: AttachmentDTO[], timestamp: number): UserMessage & { attachments?: AttachmentDTO[] } {
  const content: TextContent[] = [{ type: "text", text }];

  for (const attachment of attachments) {
    if (attachment.type === "image") {
      content.push({
        type: "image",
        data: attachment.content,
        mimeType: attachment.mimeType,
      } as any);
    } else if (attachment.type === "document" && attachment.extractedText) {
      content.push({
        type: "text",
        text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
        isDocument: true,
      } as any);
    }
  }

  return {
    role: "user",
    content,
    timestamp,
    attachments: attachments.length ? attachments : undefined,
  };
}

function createAssistantMessage(content: AssistantMessage["content"], override?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "local",
    model: "smithers-local",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...override,
  };
}

function streamAssistantMessage(text: string): {
  finalMessage: AssistantMessage;
  events: AgentEvent[];
} {
  const chunks = chunkText(text, 24);
  const partial = createAssistantMessage([{ type: "text", text: "" }]);

  const events: AgentEvent[] = [];
  events.push({ type: "message_start", message: partial });
  events.push({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
  });

  for (const chunk of chunks) {
    const content = partial.content[0] as TextContent;
    content.text += chunk;
    events.push({
      type: "message_update",
      message: { ...partial, content: [...partial.content] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk, partial },
    });
  }

  const finalMessage = createAssistantMessage([{ type: "text", text }]);
  events.push({
    type: "message_update",
    message: finalMessage,
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text, partial: finalMessage },
  });
  events.push({ type: "message_end", message: finalMessage });
  return { finalMessage, events };
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, size));
    remaining = remaining.slice(size);
  }
  return chunks.length ? chunks : [""];
}

function buildAssistantText(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return "I didn't receive any text. Try typing a message.";
  return `You said: ${trimmed}`;
}

function parseToolCommand(text: string): ToolCommand | null {
  const trimmed = text.trim();
  const match = /^([!/])(read|write|edit|bash)\s+/i.exec(trimmed);
  if (!match) return null;
  const command = match[2].toLowerCase();
  const body = trimmed.slice(match[0].length);

  if (command === "read") {
    const path = body.trim();
    if (!path) return null;
    return { name: "read", path };
  }

  if (command === "bash") {
    const cmd = body.trim();
    if (!cmd) return null;
    return { name: "bash", command: cmd };
  }

  const [firstLine, ...rest] = body.split("\n");
  const path = firstLine.trim();
  if (!path) return null;
  const content = rest.join("\n");

  if (command === "write") {
    return { name: "write", path, content };
  }

  if (command === "edit") {
    return { name: "edit", path, patch: content };
  }

  return null;
}

function toolArgsFromCommand(command: ToolCommand): Record<string, unknown> {
  switch (command.name) {
    case "read":
      return { path: command.path };
    case "write":
      return { path: command.path, content: command.content };
    case "edit":
      return { path: command.path, patch: command.patch };
    case "bash":
      return { command: command.command };
  }
}

async function runToolCommand(toolRunner: ToolRunner, command: ToolCommand) {
  switch (command.name) {
    case "read":
      return toolRunner.read(command.path);
    case "write":
      return toolRunner.write(command.path, command.content);
    case "edit":
      return toolRunner.edit(command.path, command.patch);
    case "bash":
      return toolRunner.bash(command.command);
  }
}
