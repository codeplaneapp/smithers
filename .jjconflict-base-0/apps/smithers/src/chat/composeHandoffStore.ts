import { create } from "zustand";

export type ComposeRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type ComposeSubmit = (args: { prompt: string; sourceRect?: ComposeRect }) => void;

type ComposeCardState = {
  id: string;
  title: string;
  prompt: string;
  visibleText: string;
  status: "streaming" | "submitting";
};

type BeginComposeArgs = {
  title: string;
  prompt: string;
  onSubmit: ComposeSubmit;
};

type ComposeHandoffState = {
  card: ComposeCardState | null;
  begin: (args: BeginComposeArgs) => string;
  clear: (id: string) => void;
  registerCard: (el: HTMLElement | null) => void;
};

const TOKEN_MS = 10;
const CHARS_PER_TICK = 4;
const SUBMIT_PAUSE_MS = 80;

let seq = 0;
let cardEl: HTMLElement | null = null;
let timer: number | null = null;

function nextId(): string {
  seq += 1;
  return `compose-${seq}`;
}

function clearTimer(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

function rectFromElement(el: HTMLElement | null): ComposeRect | undefined {
  if (!el) return undefined;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Visible prompt handoff for the concierge's delegation moment. Timers live in
 * the store so components stay render-only; the submit callback receives the
 * source rect needed by the run-bound toast FLIP animation.
 */
export const useComposeHandoffStore = create<ComposeHandoffState>((set, get) => ({
  card: null,
  begin: ({ title, prompt, onSubmit }) => {
    clearTimer();
    const id = nextId();
    set({
      card: {
        id,
        title,
        prompt,
        visibleText: "",
        status: "streaming",
      },
    });

    let index = 0;
    const tick = (): void => {
      const active = get().card;
      if (!active || active.id !== id) return;
      index = Math.min(prompt.length, index + CHARS_PER_TICK);
      set({
        card: {
          ...active,
          visibleText: prompt.slice(0, index),
          status: index >= prompt.length ? "submitting" : "streaming",
        },
      });
      if (index < prompt.length) {
        timer = window.setTimeout(tick, TOKEN_MS);
        return;
      }
      timer = window.setTimeout(() => {
        const sourceRect = rectFromElement(cardEl);
        onSubmit({ prompt, sourceRect });
        get().clear(id);
      }, SUBMIT_PAUSE_MS);
    };

    timer = window.setTimeout(tick, 0);
    return id;
  },
  clear: (id) => {
    const active = get().card;
    if (active?.id !== id) return;
    clearTimer();
    set({ card: null });
  },
  registerCard: (el) => {
    cardEl = el;
  },
}));

export function composePromptPreview(args: BeginComposeArgs): string {
  return useComposeHandoffStore.getState().begin(args);
}
