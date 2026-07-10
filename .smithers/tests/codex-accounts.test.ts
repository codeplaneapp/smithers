import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { subscriptionCodexFirst } from "../lib/codexAccounts";

describe("subscriptionCodexFirst", () => {
  test("uses only explicit subscription config directories before fallbacks", async () => {
    const home = await mkdtemp(join(tmpdir(), "smithers-codex-subscriptions-"));
    try {
      await writeFile(join(home, "accounts.json"), JSON.stringify({
        accounts: [
          { provider: "codex", configDir: "/subscriptions/codex-a" },
          { provider: "openai-api", apiKey: "must-not-be-used" },
          { provider: "codex", configDir: "/subscriptions/codex-a" },
          { provider: "codex", configDir: "/subscriptions/codex-b" },
        ],
      }));
      const fallback = { generate: async () => ({ text: "fallback" }) } as any;
      const agents = subscriptionCodexFirst(
        { model: "gpt-5.6-sol", inheritEnv: false },
        [fallback],
        {
          SMITHERS_HOME: home,
          CODEX_HOME: "/ambient/codex",
          OPENAI_API_KEY: "ambient-api-key",
        },
      ) as any[];

      expect(agents).toHaveLength(3);
      expect(agents.slice(0, 2).map((agent) => agent.opts.configDir)).toEqual([
        "/subscriptions/codex-a",
        "/subscriptions/codex-b",
      ]);
      expect(agents.slice(0, 2).every((agent) => agent.opts.apiKey === undefined)).toBe(true);
      expect(agents[2]).toBe(fallback);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("falls through to Claude when no Codex subscription is registered", async () => {
    const home = await mkdtemp(join(tmpdir(), "smithers-codex-subscriptions-empty-"));
    try {
      await writeFile(join(home, "accounts.json"), JSON.stringify({ accounts: [] }));
      const fallback = { generate: async () => ({ text: "fallback" }) } as any;
      expect(subscriptionCodexFirst(
        { model: "gpt-5.6-sol", inheritEnv: false },
        [fallback],
        { SMITHERS_HOME: home },
      )).toEqual([fallback]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rejects API keys on the subscription-only path", () => {
    expect(() => subscriptionCodexFirst({ apiKey: "not-allowed" })).toThrow(
      "does not accept API-key credentials",
    );
  });
});
