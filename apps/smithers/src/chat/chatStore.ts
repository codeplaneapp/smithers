import { create } from "zustand";
import type { Card } from "../cards/Card";
import { streamReplyViaApi, type ApiChatMessage } from "./streamReplyViaApi";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  /** When set, the message renders this card instead of a text bubble. */
  card?: Card;
};

/** Auto-scroll only when the reader is within this many px of the bottom. */
const AUTOSCROLL_THRESHOLD = 80;

let seq = 0;
function nextId(): string {
  seq += 1;
  return String(seq);
}

// DOM handles registered by ref callbacks. Not React state: scroll and focus are
// imperative effects driven from actions, the memory's prescribed pattern.
let conversationEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let abort: AbortController | null = null;

/** Follow the transcript to the bottom after the next paint, if already near it. */
function scrollToBottom(streaming: boolean): void {
  const el = conversationEl;
  if (!el) {
    return;
  }
  requestAnimationFrame(() => {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance > AUTOSCROLL_THRESHOLD) {
      return;
    }
    el.scrollTo({
      top: el.scrollHeight,
      behavior: streaming ? "auto" : "smooth",
    });
  });
}

type ChatState = {
  query: string;
  messages: ChatMessage[];
  pending: boolean;
  streaming: boolean;
  setQuery: (query: string) => void;
  /** Prefill and focus the composer (e.g. from a picked prompt). */
  fill: (text: string) => void;
  /** Append an assistant text line. */
  say: (text: string) => void;
  /** Append an assistant message that renders a card. */
  postCard: (card: Card, text?: string) => void;
  /** Seed the signed-out public transcript once per page lifetime. */
  seedPublicChat: () => void;
  /** Move the inline sign-in card to the bottom and replay its entrance. */
  revealSignInCard: () => void;
  /** Drop the whole conversation (e.g. replaying onboarding). */
  clear: () => void;
  registerConversation: (el: HTMLElement | null) => void;
  registerInput: (el: HTMLInputElement | null) => void;
  focusInput: () => void;
  /** Stream a reply for `text`, appending deltas to a single assistant bubble.
   *  `endpoint` lets signed-out chat target the free `/api/ask` path
   *  instead of the authenticated `/api/chat` default. */
  send: (text: string, system?: string, endpoint?: string) => Promise<void>;
};

/**
 * The conversation on the `ephemeral` medium: composer text, the message log,
 * and the streaming orchestration. The reply stream lives here as an action so
 * the shell never owns an AbortController or a stream loop in an effect.
 */
export const useChatStore = create<ChatState>((set, get) => ({
  query: "",
  messages: [],
  pending: false,
  streaming: false,
  setQuery: (query) => set({ query }),
  fill: (text) => {
    set({ query: text });
    get().focusInput();
  },
  say: (text) => {
    set((state) => ({
      messages: [...state.messages, { id: nextId(), role: "assistant", text }],
    }));
    scrollToBottom(false);
  },
  postCard: (card, text = "") => {
    set((state) => ({
      messages: [
        ...state.messages,
        { id: nextId(), role: "assistant", text, card },
      ],
    }));
    scrollToBottom(false);
  },
  seedPublicChat: () => {
    set((state) => {
      if (state.messages.some((message) => message.card?.kind === "signIn")) {
        return state;
      }
      return {
        messages: [
          ...state.messages,
          {
            id: nextId(),
            role: "assistant",
            text: "Hi, I'm Smithers, the durable control plane for long-running coding agents.\n\nYou can ask about the product here, or sign in to connect your agents, runs, and workspace.",
          },
          {
            id: nextId(),
            role: "assistant",
            text: "",
            card: { kind: "signIn" },
          },
        ],
      };
    });
    scrollToBottom(false);
  },
  revealSignInCard: () => {
    set((state) => ({
      messages: [
        ...state.messages.filter((message) => message.card?.kind !== "signIn"),
        { id: nextId(), role: "assistant", text: "", card: { kind: "signIn" } },
      ],
    }));
    scrollToBottom(false);
  },
  clear: () => {
    // Abort any in-flight stream so a late delta can't repopulate the cleared log.
    abort?.abort();
    abort = null;
    set({ messages: [], pending: false, streaming: false, query: "" });
  },
  registerConversation: (el) => {
    conversationEl = el;
  },
  registerInput: (el) => {
    inputEl = el;
    el?.focus();
  },
  focusInput: () => {
    requestAnimationFrame(() => inputEl?.focus());
  },
  send: async (text, system, endpoint) => {
    // The wire history is the conversation so far plus this turn; `messages` in
    // state does not include it yet, so build it explicitly.
    const history: ApiChatMessage[] = [
      ...get().messages.map((message) => ({
        role: message.role,
        content: message.text,
      })),
      { role: "user", content: text },
    ];
    set((state) => ({
      messages: [...state.messages, { id: nextId(), role: "user", text }],
      pending: true,
      streaming: true,
    }));
    scrollToBottom(true);

    // Abort any prior stream before starting a new one, then track this one's
    // controller so the next send can cancel it.
    abort?.abort();
    const controller = new AbortController();
    abort = controller;

    const assistantId = nextId();
    let acc = "";
    let started = false;
    try {
      for await (const delta of streamReplyViaApi({
        messages: history,
        system,
        endpoint,
        signal: controller.signal,
      })) {
        acc += delta;
        if (!started) {
          started = true;
          set((state) => ({
            pending: false,
            messages: [
              ...state.messages,
              { id: assistantId, role: "assistant", text: acc },
            ],
          }));
        } else {
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === assistantId ? { ...message, text: acc } : message,
            ),
          }));
        }
        scrollToBottom(true);
      }
      if (!started) {
        set((state) => ({
          messages: [
            ...state.messages,
            { id: assistantId, role: "assistant", text: "(no response)" },
          ],
        }));
      }
    } catch (error) {
      // A newer send aborts this one — expected, not an error to render.
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      const offline =
        (typeof navigator !== "undefined" && navigator.onLine === false) ||
        error instanceof TypeError;
      const message = offline
        ? "You appear to be offline, chat needs a connection."
        : error instanceof Error
          ? error.message
          : "Something went wrong talking to the chat backend.";
      set((state) => ({
        messages: started
          ? state.messages.map((entry) =>
              entry.id === assistantId
                ? { ...entry, text: `${acc}\n\n⚠️ ${message}` }
                : entry,
            )
          : [
              ...state.messages,
              { id: assistantId, role: "assistant", text: `⚠️ ${message}` },
            ],
      }));
    } finally {
      // Only the active stream clears the flags; a newer send owns them now.
      if (abort === controller) {
        set({ pending: false, streaming: false });
        abort = null;
      }
      scrollToBottom(false);
    }
  },
}));
