import { create } from "zustand";
import { useNotificationsStore } from "../notifications/notificationsStore";

/**
 * Local-only chat shim.
 *
 * The cloud `multi` app is chat-first: a composer streams to a Cloudflare Worker
 * (`/api/chat`) and renders an assistant transcript with inline cards. This
 * local UI has NO chat backend — the gateway serves runs/approvals/etc., not a
 * model. So the surfaces' incidental `chat.say(...)`/`chat.postCard(...)` calls
 * (status confirmations like "Saved ticket X", "Run forked") are routed to the
 * corner toast stack instead, and the composer methods are inert.
 *
 * The store keeps the FULL shape the surfaces touch — `query`, `messages`,
 * `streaming`, plus `subscribe`/`setState` (used by controlStore's directive
 * bridge) — so nothing has to know the transcript is gone. `streaming` never
 * flips true, so the control bridge simply never fires.
 */
export type ChatRole = "user" | "assistant";

/** A loose card descriptor — surfaces post launch/run/approval cards. */
export type Card = { kind: string; [key: string]: unknown };

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  card?: Card;
};

type ChatState = {
  query: string;
  messages: ChatMessage[];
  pending: boolean;
  streaming: boolean;
  setQuery: (query: string) => void;
  fill: (text: string) => void;
  say: (text: string) => void;
  postCard: (card: Card, text?: string) => void;
  seedPublicChat: () => void;
  clear: () => void;
  registerConversation: (el: HTMLElement | null) => void;
  registerInput: (el: HTMLInputElement | null) => void;
  focusInput: () => void;
  send: (text: string, system?: string, endpoint?: string) => Promise<void>;
};

let seq = 0;
function nextId(): string {
  seq += 1;
  return `m${seq}`;
}

let inputEl: HTMLInputElement | null = null;

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
  // Surface confirmations become transient toasts in local mode.
  say: (text) => {
    useNotificationsStore.getState().notify({ title: text, kind: "transient" });
  },
  postCard: (card, text = "") => {
    useNotificationsStore.getState().notify({
      title: text || `${card.kind}`,
      kind: "transient",
    });
  },
  seedPublicChat: () => {},
  clear: () => set({ messages: [], pending: false, streaming: false, query: "" }),
  registerConversation: () => {},
  registerInput: (el) => {
    inputEl = el;
  },
  focusInput: () => {
    requestAnimationFrame(() => inputEl?.focus());
  },
  // No chat backend in local mode — record the prompt, answer with a hint.
  send: async (text) => {
    if (!text.trim()) return;
    useNotificationsStore.getState().notify({
      title: "Local mode has no chat backend",
      detail: "Use the surfaces (Runs, Approvals, Workflows) to drive the gateway.",
      kind: "transient",
    });
  },
}));
