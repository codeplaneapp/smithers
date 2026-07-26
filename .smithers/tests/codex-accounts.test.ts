import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexFirst, codexPaused, subscriptionCodexFirst } from "../lib/codexAccounts";

describe("subscriptionCodexFirst", () => {
  test("uses only explicit subscription config directories before fallbacks", async () => {
    const home = await mkdtemp(join(tmpdir(), "smithers-codex-subscriptions-"));
    try {
      await writeFile(
        join(home, "accounts.json"),
        JSON.stringify({
          accounts: [
            { provider: "codex", configDir: "/subscriptions/codex-a" },
            { provider: "openai-api", apiKey: "must-not-be-used" },
            { provider: "codex", configDir: "/subscriptions/codex-a" },
            { provider: "codex", configDir: "/subscriptions/codex-b" },
          ],
        }),
      );
      const fallback = { generate: async () => ({ text: "fallback" }) } as any;
      const agents = subscriptionCodexFirst({ model: "gpt-5.6-sol", inheritEnv: false }, [fallback], {
        SMITHERS_HOME: home,
        CODEX_HOME: "/ambient/codex",
        OPENAI_API_KEY: "ambient-api-key",
      }) as any[];

      expect(agents).toHaveLength(3);
      expect(agents.slice(0, 2).map((agent) => agent.opts.configDir)).toEqual([
        "/subscriptions/codex-a",
        "/subscriptions/codex-b",
      ]);
      expect(agents.slice(0, 2).every((agent) => agent.opts.apiKey === undefined)).toBe(true);
      expect(agents[2]).toBe(fallback);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test("falls through to Claude when no Codex subscription is registered", async () => {
    const home = await mkdtemp(join(tmpdir(), "smithers-codex-subscriptions-empty-"));
    try {
      await writeFile(join(home, "accounts.json"), JSON.stringify({ accounts: [] }));
      const fallback = { generate: async () => ({ text: "fallback" }) } as any;
      expect(
        subscriptionCodexFirst({ model: "gpt-5.6-sol", inheritEnv: false }, [fallback], { SMITHERS_HOME: home }),
      ).toEqual([fallback]);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test("rejects API keys on the subscription-only path", () => {
    expect(() => subscriptionCodexFirst({ apiKey: "not-allowed" })).toThrow("does not accept API-key credentials");
  });
});

describe("codexPaused kill-switch", () => {
  const fallback = { generate: async () => ({ text: "fallback" }) } as any;

  test("codex-paused.json marker flips codexFirst and subscriptionCodexFirst to fallbacks only", async () => {
    const home = await mkdtemp(join(tmpdir(), "smithers-codex-paused-"));
    try {
      await writeFile(
        join(home, "codex-paused.json"),
        JSON.stringify({
          reason: "codex usage limit hit",
          pausedAt: "2026-07-11T20:30:00Z",
        }),
      );
      const env = { SMITHERS_HOME: home };
      expect(codexPaused(env)).toBe(true);
      expect(codexFirst({ model: "gpt-5.6-luna" }, [fallback], env)).toEqual([fallback]);
      expect(subscriptionCodexFirst({ model: "gpt-5.6-sol" }, [fallback], env)).toEqual([fallback]);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test("a chain with no fallback keeps Codex rather than going empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "smithers-codex-paused-nofallback-"));
    try {
      await writeFile(join(home, "codex-paused.json"), "{}");
      const agents = codexFirst({ model: "gpt-5.6-luna", inheritEnv: false }, [], { SMITHERS_HOME: home });
      expect(agents).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test("an expired until timestamp un-pauses; a future one pauses; malformed bodies pause", async () => {
    const home = await mkdtemp(join(tmpdir(), "smithers-codex-paused-until-"));
    try {
      await writeFile(join(home, "codex-paused.json"), JSON.stringify({ until: "2001-01-01T00:00:00Z" }));
      expect(codexPaused({ SMITHERS_HOME: home })).toBe(false);
      await writeFile(join(home, "codex-paused.json"), JSON.stringify({ until: "2999-01-01T00:00:00Z" }));
      expect(codexPaused({ SMITHERS_HOME: home })).toBe(true);
      await writeFile(join(home, "codex-paused.json"), "{not json");
      expect(codexPaused({ SMITHERS_HOME: home })).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test("SMITHERS_CODEX_PAUSED env overrides in both directions", async () => {
    const home = await mkdtemp(join(tmpdir(), "smithers-codex-paused-env-"));
    try {
      expect(codexPaused({ SMITHERS_HOME: home, SMITHERS_CODEX_PAUSED: "1" })).toBe(true);
      await writeFile(join(home, "codex-paused.json"), "{}");
      expect(codexPaused({ SMITHERS_HOME: home, SMITHERS_CODEX_PAUSED: "0" })).toBe(false);
      expect(codexPaused({ SMITHERS_HOME: home, SMITHERS_CODEX_PAUSED: "off" })).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test("no marker and no env means codex stays first", async () => {
    const home = await mkdtemp(join(tmpdir(), "smithers-codex-unpaused-"));
    try {
      expect(codexPaused({ SMITHERS_HOME: home })).toBe(false);
      const agents = codexFirst({ model: "gpt-5.6-luna", inheritEnv: false }, [fallback], { SMITHERS_HOME: home });
      expect(agents.length).toBeGreaterThan(1);
      expect(agents[agents.length - 1]).toBe(fallback);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });
});
