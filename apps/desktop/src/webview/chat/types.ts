/**
 * Chat message types - minimal definitions for the UI
 * These mirror the pi-ai types but are self-contained
 */

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  attachments?: unknown[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

export interface WorkflowCardMessage {
  role: "workflow";
  type: "smithers.workflow.card";
  runId: string;
  workflowName: string;
  status: "running" | "waiting-approval" | "finished" | "failed" | "cancelled";
  primaryNodeId?: string;
  approvals?: Array<{ nodeId: string; iteration?: number }>;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage | WorkflowCardMessage;

// Agent events from the Bun process
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "message_start"; message: AssistantMessage }
  | { type: "message_update"; message: AssistantMessage }
  | { type: "message_end"; message: Message }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string }
  | { type: "turn_end" }
  | { type: "agent_end" };

// Transport interface for sending messages to Bun
export interface ChatTransport {
  run(
    messages: Message[],
    userMessage: Message,
    config: unknown,
    signal?: AbortSignal
  ): AsyncIterable<AgentEvent>;

  continue(
    messages: Message[],
    config: unknown,
    signal?: AbortSignal
  ): AsyncIterable<AgentEvent>;
}
