import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDirPath } from "../../testing/src/cleanup/tempDir.ts";
import { ClaudeCodeAgent, CodexAgent, GrokAgent, fallbackAgents } from "../src/index.js";
import { recordAccountQuotaLimit, writeUsageCache } from "@smthrs/usage";

/**
 * Writes an accounts.json registry into a fresh SMITHERS_HOME and returns the
 * env to pass to fallbackAgents.
 *
 * @param {object[]} accounts
 * @returns {NodeJS.ProcessEnv}
 */
function registryEnv(accounts) {
  const home = makeTempDirPath("smithers-fallback-agents-");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts }, null, 2));
  return { SMITHERS_HOME: home };
}

const CLAUDE_1 = { label: "claude-1", provider: "claude-code", configDir: "/tmp/claude-1" };
const CLAUDE_2 = { label: "claude-2", provider: "claude-code", configDir: "/tmp/claude-2" };
const CODEX_1 = { label: "codex-1", provider: "codex", configDir: "/tmp/codex-1", model: "gpt-5.6-sol" };
const GROK_1 = { label: "grok-1", provider: "grok", configDir: "/tmp/grok-1" };
const GROK_2 = { label: "grok-2", provider: "grok", configDir: "/tmp/grok-2" };
const XAI_1 = { label: "xai-1", provider: "xai-api", apiKey: "xai-test-key" };

describe("fallbackAgents", () => {
  test("builds one agent per registered claude/codex account plus the default fallback tail", () => {
    const env = registryEnv([CLAUDE_1, CLAUDE_2, CODEX_1]);
    const chain = fallbackAgents({ env, shuffle: false });
    expect(chain).toHaveLength(4);
    const [a, b, c, tail] = chain;
    expect(a).toBeInstanceOf(ClaudeCodeAgent);
    expect(a.opts.configDir).toBe("/tmp/claude-1");
    expect(a.opts.id).toBe("smithers-account:claude-1");
    expect(b.opts.configDir).toBe("/tmp/claude-2");
    expect(c).toBeInstanceOf(CodexAgent);
    expect(c.opts.configDir).toBe("/tmp/codex-1");
    expect(c.opts.model).toBe("gpt-5.6-sol");
    expect(c.opts.skipGitRepoCheck).toBe(true);
    // Tail is the stock "normal" agent with no account identity.
    expect(tail).toBeInstanceOf(ClaudeCodeAgent);
    expect(tail.opts.configDir).toBeUndefined();
    expect(tail.opts.id).toBeUndefined();
  });

  test("builds Grok subscription and API accounts and sinks a rate-limited account", () => {
    const env = registryEnv([GROK_1, GROK_2, XAI_1]);
    recordAccountQuotaLimit("grok-1", { env, untilMs: Date.now() + 60_000 });
    const chain = fallbackAgents({ env, providers: ["grok", "xai-api"], fallback: [], shuffle: false });
    expect(chain.map((agent) => agent.id)).toEqual([
      "smithers-account:grok-2",
      "smithers-account:xai-1",
      "smithers-account:grok-1",
    ]);
    expect(chain[0]).toBeInstanceOf(GrokAgent);
    expect(chain[0].opts.configDir).toBe("/tmp/grok-2");
    expect(chain[1]).toBeInstanceOf(GrokAgent);
    expect(chain[1].opts.apiKey).toBe("xai-test-key");
    expect(chain[1].opts.configDir).toContain("xai-1");
  });

  test("agentOptions applies caller authority to every pooled rung", () => {
    // A task that pins a read-only sandbox must keep it when its single agent
    // becomes a pool; otherwise load balancing silently widens authority.
    const env = registryEnv([CLAUDE_1, CLAUDE_2, CODEX_1]);
    const chain = fallbackAgents({
      env,
      shuffle: false,
      fallback: [],
      agentOptions: {
        "claude-code": { tools: ["Read", "Grep"] },
        codex: { sandbox: "read-only" },
      },
    });
    expect(chain).toHaveLength(3);
    expect(chain[0].opts.tools).toEqual(["Read", "Grep"]);
    expect(chain[1].opts.tools).toEqual(["Read", "Grep"]);
    expect(chain[2].opts.sandbox).toBe("read-only");
    // Provider defaults still apply where the caller did not override them.
    expect(chain[2].opts.skipGitRepoCheck).toBe(true);
  });

  test("agentOptions cannot repoint a rung at another subscription", () => {
    const env = registryEnv([CLAUDE_1]);
    const chain = fallbackAgents({
      env,
      shuffle: false,
      fallback: [],
      agentOptions: { "claude-code": { configDir: "/tmp/somebody-else", id: "forged" } },
    });
    expect(chain).toHaveLength(1);
    expect(chain[0].opts.configDir).toBe("/tmp/claude-1");
    expect(chain[0].opts.id).toBe("smithers-account:claude-1");
  });

  test("shuffles registered accounts but never the fallback tail", () => {
    const env = registryEnv([CLAUDE_1, CLAUDE_2, CODEX_1]);
    // random() => 0 swaps deterministically: Fisher–Yates with j=0 each step.
    const chain = fallbackAgents({ env, random: () => 0 });
    expect(chain).toHaveLength(4);
    const labels = chain.slice(0, 3).map((agent) => agent.opts.id);
    expect([...labels].sort()).toEqual([
      "smithers-account:claude-1",
      "smithers-account:claude-2",
      "smithers-account:codex-1",
    ]);
    expect(labels[0]).not.toBe("smithers-account:claude-1"); // j=0 moved the head
    expect(chain[3].opts.id).toBeUndefined();
  });

  test("seed gives a stable order per seed and different orders across seeds", () => {
    const env = registryEnv([CLAUDE_1, CLAUDE_2, CODEX_1]);
    const order = (seed) => fallbackAgents({ env, seed }).map((agent) => agent.opts.id ?? "tail");
    expect(order("run-a")).toEqual(order("run-a"));
    const seeds = ["run-a", "run-b", "run-c", "run-d", "run-e", "run-f"];
    const distinct = new Set(seeds.map((seed) => order(seed).join(">")));
    expect(distinct.size).toBeGreaterThan(1);
  });

  test("orders by cached Fable headroom before the seeded tie-break", () => {
    const env = registryEnv([CLAUDE_1, CLAUDE_2]);
    const entry = (label, usedPercent) => ({
      identity: { provider: "claude-code", configDir: `/tmp/${label}` },
      report: {
        accountLabel: label,
        provider: "claude-code",
        authMode: "subscription",
        source: "oauth",
        windows: [{ id: "weekly-fable", label: "weekly Fable", unit: "percent", usedPercent }],
        fetchedAt: new Date().toISOString(),
        stale: false,
        estimate: false,
      },
    });
    writeUsageCache(
      { version: 1, entries: { "claude-1": entry("claude-1", 80), "claude-2": entry("claude-2", 10) } },
      env,
    );
    const chain = fallbackAgents({
      env,
      models: { "claude-code": "claude-fable-5" },
      fallback: [],
      seed: "run-a",
    });
    expect(chain.map((agent) => agent.id)).toEqual(["smithers-account:claude-2", "smithers-account:claude-1"]);
  });

  test("uses a no-network sentinel for a persisted quota block", async () => {
    const env = registryEnv([CLAUDE_1]);
    const nowMs = Date.now();
    recordAccountQuotaLimit("claude-1", { env, nowMs, untilMs: nowMs + 60_000 });
    const [blocked] = fallbackAgents({ env, fallback: [] });
    await expect(blocked.generate()).rejects.toMatchObject({
      code: "AGENT_QUOTA_EXCEEDED",
      details: { persistedQuota: true, quotaResetAtMs: nowMs + 60_000 },
    });
  });

  test("a sentinel hands off to the real agent once its reset has passed", async () => {
    const env = registryEnv([CLAUDE_1]);
    const nowMs = Date.now();
    // A generated agents.ts spreads one pool at module load, so a chain built
    // while an account was blocked must not retire it for the whole process.
    recordAccountQuotaLimit("claude-1", { env, nowMs, untilMs: nowMs + 400 });
    const [blocked] = fallbackAgents({ env, fallback: [] });
    // An already-aborted signal keeps the delegation cheap: the real adapter
    // must own the rejection, so it cannot be the persisted-quota sentinel.
    const abortSignal = AbortSignal.abort();
    await expect(blocked.generate({ prompt: "hi", abortSignal })).rejects.toMatchObject({
      code: "AGENT_QUOTA_EXCEEDED",
      details: { persistedQuota: true },
    });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, nowMs + 420 - Date.now())));
    const revived = await blocked.generate({ prompt: "hi", abortSignal }).then(
      () => null,
      (error) => error,
    );
    expect(revived?.details?.persistedQuota).toBeUndefined();
  });

  test("keeps seeded chain positions stable after quota state changes", async () => {
    const env = registryEnv([CLAUDE_1, CLAUDE_2]);
    const first = fallbackAgents({ env, fallback: [], seed: "stable-run" });
    const labels = first.map((agent) => agent.id);
    const blockedLabel = labels[0].replace("smithers-account:", "");
    recordAccountQuotaLimit(blockedLabel, { env, untilMs: Date.now() + 60_000 });
    const second = fallbackAgents({ env, fallback: [], seed: "stable-run" });
    expect(second.map((agent) => agent.id)).toEqual(labels);
    await expect(second[0].generate()).rejects.toMatchObject({
      code: "AGENT_QUOTA_EXCEEDED",
      details: { persistedQuota: true },
    });
  });

  test("uses a no-network sentinel for exhausted cached usage", async () => {
    const env = registryEnv([CLAUDE_1]);
    writeUsageCache(
      {
        version: 1,
        entries: {
          "claude-1": {
            identity: { provider: "claude-code", configDir: CLAUDE_1.configDir },
            report: {
              accountLabel: "claude-1",
              provider: "claude-code",
              authMode: "subscription",
              source: "oauth",
              windows: [
                {
                  id: "weekly-fable",
                  label: "weekly Fable",
                  unit: "percent",
                  usedPercent: 100,
                  resetsAt: new Date(Date.now() + 60_000).toISOString(),
                },
              ],
              fetchedAt: new Date().toISOString(),
              stale: false,
              estimate: false,
            },
          },
        },
      },
      env,
    );
    const [blocked] = fallbackAgents({
      env,
      fallback: [],
      models: { "claude-code": "claude-fable-5" },
    });
    await expect(blocked.generate()).rejects.toMatchObject({ code: "AGENT_QUOTA_EXCEEDED" });
  });

  test("a Fable quota callback does not block the same account for Opus", async () => {
    const env = registryEnv([CLAUDE_1]);
    const untilMs = Date.now() + 60_000;
    const [fable] = fallbackAgents({
      env,
      models: { "claude-code": "claude-fable-5" },
      fallback: [],
    });
    fable.onQuotaExceeded({ underlying: "You're out of usage credits for Fable", quotaResetAtMs: untilMs });
    const [blockedFable] = fallbackAgents({
      env,
      models: { "claude-code": "claude-fable-5" },
      fallback: [],
    });
    await expect(blockedFable.generate()).rejects.toMatchObject({ code: "AGENT_QUOTA_EXCEEDED" });
    const [availableOpus] = fallbackAgents({
      env,
      models: { "claude-code": "claude-opus-5" },
      fallback: [],
    });
    expect(availableOpus).toBeInstanceOf(ClaudeCodeAgent);
    expect(availableOpus.opts.configDir).toBe(CLAUDE_1.configDir);
  });

  test("persists quota before invoking a caller hook that throws", () => {
    const env = registryEnv([CLAUDE_1]);
    const [agent] = fallbackAgents({
      env,
      fallback: [],
      agentOptions: {
        "claude-code": {
          onQuotaExceeded() {
            throw new Error("caller failed");
          },
        },
      },
    });
    expect(() => agent.onQuotaExceeded({ quotaResetAtMs: Date.now() + 60_000 })).toThrow("caller failed");
    const [blocked] = fallbackAgents({ env, fallback: [] });
    expect(blocked.constructor.name).not.toBe("ClaudeCodeAgent");
  });

  test("providers filter narrows the pool and picks the matching default fallback", () => {
    const env = registryEnv([CLAUDE_1, CODEX_1]);
    const chain = fallbackAgents({ env, providers: ["codex"], shuffle: false });
    expect(chain).toHaveLength(2);
    expect(chain[0]).toBeInstanceOf(CodexAgent);
    expect(chain[1]).toBeInstanceOf(CodexAgent);
    expect(chain[1].opts.configDir).toBeUndefined();
  });

  test("models option overrides the account's registered model", () => {
    const env = registryEnv([CODEX_1]);
    const chain = fallbackAgents({ env, models: { codex: "gpt-5.6-terra" }, shuffle: false });
    expect(chain[0].opts.model).toBe("gpt-5.6-terra");
  });

  test("returns the provided fallback alone when no accounts are registered", () => {
    const env = registryEnv([]);
    const normal = new ClaudeCodeAgent({ model: "claude-fable-5" });
    expect(fallbackAgents({ env, fallback: normal })).toEqual([normal]);
    expect(fallbackAgents({ env, fallback: [] })).toEqual([]);
    const defaulted = fallbackAgents({ env });
    expect(defaulted).toHaveLength(1);
    expect(defaulted[0]).toBeInstanceOf(ClaudeCodeAgent);
  });

  test("missing SMITHERS_HOME registry degrades to the fallback instead of throwing", () => {
    const env = { SMITHERS_HOME: join(tmpdir(), "smithers-fallback-agents-missing", "nope") };
    const chain = fallbackAgents({ env });
    expect(chain).toHaveLength(1);
    expect(chain[0]).toBeInstanceOf(ClaudeCodeAgent);
  });

  test("corrupt registry degrades to the fallback instead of throwing", () => {
    const home = makeTempDirPath("smithers-fallback-agents-corrupt-");
    writeFileSync(join(home, "accounts.json"), "{not json");
    const normal = new CodexAgent({ skipGitRepoCheck: true });
    const chain = fallbackAgents({ env: { SMITHERS_HOME: home }, fallback: normal });
    expect(chain).toEqual([normal]);
  });

  test("api-key accounts join only when opted in and carrying a real key", () => {
    const env = registryEnv([
      { label: "anthropic-1", provider: "anthropic-api", apiKey: "sk-test" },
      { label: "anthropic-empty", provider: "anthropic-api", apiKey: "" },
      CLAUDE_1,
    ]);
    const defaultChain = fallbackAgents({ env, shuffle: false });
    // anthropic-api is not in the default provider set.
    expect(defaultChain.map((agent) => agent.opts.id)).toEqual(["smithers-account:claude-1", undefined]);
    const optedIn = fallbackAgents({ env, providers: ["claude-code", "anthropic-api"], shuffle: false });
    const ids = optedIn.map((agent) => agent.opts.id);
    expect(ids).toContain("smithers-account:anthropic-1");
    // Empty env-var-only keys are indistinguishable from the ambient default: skipped.
    expect(ids).not.toContain("smithers-account:anthropic-empty");
    expect(optedIn.find((agent) => agent.opts.id === "smithers-account:anthropic-1").opts.apiKey).toBe("sk-test");
  });

  test("unknown providers in the registry are carried past, not crashed on", () => {
    const env = registryEnv([{ label: "mystery-1", provider: "mystery" }, CLAUDE_1]);
    const chain = fallbackAgents({ env, shuffle: false });
    expect(chain.map((agent) => agent.opts.id)).toEqual(["smithers-account:claude-1", undefined]);
  });
});
