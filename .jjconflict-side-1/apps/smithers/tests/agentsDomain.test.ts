import { describe, expect, test } from "bun:test";
import {
  AGENTS,
  CODEX_5_6_MODELS,
  DEFAULT_CODEX_MODEL,
  PROVIDERS,
  findProvider,
  registerAccount,
} from "../src/agents/agents";
import { useAgentsStore } from "../src/agents/agentsStore";

describe("Codex-first agents registry", () => {
  test("advertises the complete Codex 5.6 family before fallback providers", () => {
    expect(AGENTS[0]?.id).toBe("codex");
    expect(AGENTS[0]?.detail).toContain("Luna");
    expect(AGENTS[0]?.detail).toContain("Terra");
    expect(AGENTS[0]?.detail).toContain("Sol");
    expect(AGENTS.find((agent) => agent.id === "claude")?.detail).toContain("fallback only");
    expect(AGENTS.find((agent) => agent.id === "kimi")?.detail).toContain("fallback only");
  });

  test("defaults Codex registrations to Luna while offering all three tiers", () => {
    expect(PROVIDERS[0]?.id).toBe("codex");
    expect(findProvider("codex")?.modelPlaceholder).toBe(DEFAULT_CODEX_MODEL);
    expect(findProvider("codex")?.modelOptions).toEqual(CODEX_5_6_MODELS);
    expect(findProvider("openai-api")?.modelOptions).toEqual(CODEX_5_6_MODELS);

    const account = registerAccount(
      {
        providerId: "codex",
        label: "codex-default",
        configDir: "~/.codex",
        apiKey: "",
        model: "",
        force: false,
      },
      [],
    );

    expect(account?.model).toBe("gpt-5.6-luna");
    expect(account?.roles).toEqual(["coding", "implement", "research", "spec", "review"]);
  });

  test("opens the registration drawer on Codex", () => {
    useAgentsStore.getState().openRegister();
    expect(useAgentsStore.getState().draftProviderId).toBe("codex");
  });
});
