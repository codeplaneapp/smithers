import { describe, expect, test } from "bun:test";

import {
  isPricedAnthropicRequestModel,
  modelPrices,
} from "../../src/server/proxy/modelPrices.ts";
import { recordUsage } from "../../src/server/proxy/recordUsage.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

describe("modelPrices", () => {
  test("includes GPT-5.6 Sol, Terra, and Luna", () => {
    expect(modelPrices("gpt-5.6-sol")).toEqual({ input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(modelPrices("gpt-5.6-terra")).toEqual({ input: 2.5, output: 15, cacheWrite: 3.125, cacheRead: 0.25 });
    expect(modelPrices("gpt-5.6-luna")).toEqual({ input: 1, output: 6, cacheWrite: 1.25, cacheRead: 0.1 });
  });

  test("prices the base model id", () => {
    expect(modelPrices("claude-opus-4-8").input).toBe(15);
  });

  test("prices a date-stamped suffix", () => {
    expect(modelPrices("claude-haiku-4-5-20251001").input).toBe(0.8);
  });

  test("prices a bracketed context-window alias (not metered as free)", () => {
    // claude-opus-4-8[1m] is a real model; it must not fall through to $0.
    const price = modelPrices("claude-opus-4-8[1m]");
    expect(price.input).toBe(15);
    expect(price.output).toBe(75);
  });

  test("request admission accepts only exact, dated, and explicit context aliases", () => {
    expect(isPricedAnthropicRequestModel("claude-haiku-4-5")).toBe(true);
    expect(isPricedAnthropicRequestModel("claude-haiku-4-5-20251001")).toBe(true);
    expect(isPricedAnthropicRequestModel("claude-opus-4-8[1m]")).toBe(true);
    expect(isPricedAnthropicRequestModel("claude-opus-4-8-20251001[1m]")).toBe(true);
    expect(isPricedAnthropicRequestModel("claude-haiku-4-5-premium")).toBe(false);
    expect(isPricedAnthropicRequestModel("claude-haiku-4-5_preview")).toBe(false);
    expect(isPricedAnthropicRequestModel("claude-opus-4-8[2m]")).toBe(false);
    expect(isPricedAnthropicRequestModel("gpt-5.6-sol")).toBe(false);
  });

  test("unknown models record $0", () => {
    expect(modelPrices("some-unknown-model").input).toBe(0);
  });

  test("recordUsage charges a provider prefix mismatch at the conservative fallback", async () => {
    const env = await buildTestEnv();
    const sessionHash = "unknown-model-session";
    await env.DB
      .prepare(
        "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(sessionHash, "acme/repo", 7, Date.now() + 60_000, 1_000, 0, Date.now())
      .run();

    const recorded = await recordUsage(env.DB, {
      sessionHash,
      repo: "acme/repo",
      pr: 7,
      summary: {
        model: "claude-haiku-4-5-premium",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      },
      kind: "messages",
      now: Date.now(),
    });

    // Highest current supported rates: 15 + 75 + 18.75 + 1.5.
    expect(recorded.costUsd).toBeCloseTo(110.25, 8);
    const session = await env.DB
      .prepare("SELECT spent_usd FROM sessions WHERE hash = ?")
      .bind(sessionHash)
      .first<{ spent_usd: number }>();
    expect(session?.spent_usd).toBeCloseTo(110.25, 8);
    const event = await env.DB
      .prepare("SELECT model, cost_usd FROM usage_events WHERE repo = ?")
      .bind("acme/repo")
      .first<{ model: string; cost_usd: number }>();
    expect(event).toEqual({ model: "claude-haiku-4-5-premium", cost_usd: 110.25 });
  });

  test("recordUsage rolls back session spend and retains the lease when the ledger insert fails", async () => {
    const env = await buildTestEnv();
    const sessionHash = "atomic-settlement-session";
    const now = Date.now();
    await env.DB
      .prepare(
        "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(sessionHash, "acme/atomic", 8, now + 60_000, 10, 0, now)
      .run();
    await env.DB
      .prepare(
        "INSERT INTO spend_reservations (id, session_hash, repo, amount_usd, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("reservation-atomic", sessionHash, "acme/atomic", 0.5, now + 60_000, now)
      .run();
    await env.DB.exec("DROP TABLE usage_events");

    await expect(recordUsage(env.DB, {
      sessionHash,
      repo: "acme/atomic",
      pr: 8,
      summary: {
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 10,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      kind: "messages",
      now,
      reservationId: "reservation-atomic",
    })).rejects.toThrow();

    const session = await env.DB
      .prepare("SELECT spent_usd FROM sessions WHERE hash = ?")
      .bind(sessionHash)
      .first<{ spent_usd: number }>();
    expect(session?.spent_usd).toBe(0);
    const reservation = await env.DB
      .prepare("SELECT id FROM spend_reservations WHERE id = ?")
      .bind("reservation-atomic")
      .first<{ id: string }>();
    expect(reservation?.id).toBe("reservation-atomic");
  });
});
