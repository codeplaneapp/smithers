/**
 * ChatAgent - Simple state container for chat messages
 * Replaces pi-web-ui's Agent class
 */

import type { Message, AssistantMessage, ChatTransport, AgentEvent } from "./types.js";

export interface ChatAgentState {
  messages: Message[];
  isStreaming: boolean;
  streamingMessage: AssistantMessage | null;
  error?: string;
}

export type ChatAgentListener = (state: ChatAgentState) => void;

export interface ChatAgentOptions {
  transport: ChatTransport;
  initialState?: Partial<ChatAgentState>;
}

export class ChatAgent {
  private _state: ChatAgentState;
  private listeners = new Set<ChatAgentListener>();
  private transport: ChatTransport;
  private abortController?: AbortController;

  constructor(opts: ChatAgentOptions) {
    this._state = {
      messages: [],
      isStreaming: false,
      streamingMessage: null,
      ...opts.initialState,
    };
    this.transport = opts.transport;
  }

  get state(): ChatAgentState {
    return this._state;
  }

  subscribe(fn: ChatAgentListener): () => void {
    this.listeners.add(fn);
    fn(this._state);
    return () => this.listeners.delete(fn);
  }

  appendMessage(message: Message): void {
    this.patch({ messages: [...this._state.messages, message] });
  }

  replaceMessages(messages: Message[]): void {
    this.patch({ messages: [...messages] });
  }

  clearMessages(): void {
    this.patch({ messages: [] });
  }

  abort(): void {
    this.abortController?.abort();
  }

  async send(text: string, attachments?: unknown[]): Promise<void> {
    console.log("[ChatAgent] send() called with text:", text);
    const userMessage: Message = {
      role: "user",
      content: text,
      attachments,
      timestamp: Date.now(),
    };

    this.appendMessage(userMessage);
    console.log("[ChatAgent] User message appended, total messages:", this._state.messages.length);
    this.abortController = new AbortController();
    this.patch({ isStreaming: true, streamingMessage: null, error: undefined });

    try {
      for await (const event of this.transport.run(
        this._state.messages,
        userMessage,
        {},
        this.abortController.signal
      )) {
        this.handleEvent(event);
        if (event.type === "agent_end") break;
      }
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.patch({ isStreaming: false, streamingMessage: null });
      this.abortController = undefined;
    }
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
      case "message_update":
        this.patch({ streamingMessage: event.message });
        break;
      case "message_end":
        // Only append if not already present (user messages are added upfront in send())
        if (event.message.role !== "user") {
          this.appendMessage(event.message);
        }
        this.patch({ streamingMessage: null });
        break;
    }
  }

  private patch(partial: Partial<ChatAgentState>): void {
    this._state = { ...this._state, ...partial };
    for (const listener of this.listeners) {
      listener(this._state);
    }
  }
}
