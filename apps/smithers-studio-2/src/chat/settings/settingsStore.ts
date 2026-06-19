import { create } from "zustand";
import { useToastStore } from "../toasts/toastStore";

/**
 * The selectable default orchestration agent. Default is **codex** (Product spec
 * §5). Switching it may force a new session and re-warm the prompt cache, which
 * the UI surfaces as an ephemeral notice.
 */
export type DefaultAgent = "codex" | "claude" | "antigravity" | "kimi";

export const DEFAULT_AGENTS: { id: DefaultAgent; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
  { id: "antigravity", label: "Antigravity" },
  { id: "kimi", label: "Kimi" },
];

const AGENT_STORAGE_KEY = "studio.defaultAgent";

function readDefaultAgent(): DefaultAgent {
  if (typeof localStorage === "undefined") return "codex";
  const stored = localStorage.getItem(AGENT_STORAGE_KEY);
  return DEFAULT_AGENTS.some((a) => a.id === stored) ? (stored as DefaultAgent) : "codex";
}

function persistDefaultAgent(value: DefaultAgent): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(AGENT_STORAGE_KEY, value);
}

type SettingsState = {
  defaultAgent: DefaultAgent;
  setDefaultAgent: (agent: DefaultAgent) => void;
};

/**
 * Minimal Studio 2 settings. Mock today — just persists to the store +
 * localStorage. Switching the default agent fires the ephemeral "switching
 * models breaks the cache" notice (mock) so the cost is visible.
 */
export const useSettingsStore = create<SettingsState>((set, get) => ({
  defaultAgent: readDefaultAgent(),

  setDefaultAgent: (agent) => {
    if (agent === get().defaultAgent) return;
    persistDefaultAgent(agent);
    set({ defaultAgent: agent });
    useToastStore
      .getState()
      .notify("Switching models breaks the cache and starts a new session — you may pay to re-warm tokens.");
  },
}));
