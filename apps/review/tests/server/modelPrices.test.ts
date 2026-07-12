import { describe, expect, test } from "bun:test";

import {
  isPricedAnthropicRequestModel,
  modelPrices,
} from "../../src/server/proxy/modelPrices.ts";
import { recordUsage } from "../../src/server/proxy/recordUsage.ts";
import {
  estimateMessagesSpend,
  prepareMessagesRequest,
} from "../../src/server/proxy/spendReservations.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

describe("modelPrices", () => {
  test("includes GPT-5.6 Sol, Terra, and Luna", () => {
    expect(modelPrices("gpt-5.6-sol")).toEqual({ input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(modelPrices("gpt-5.6-terra")).toEqual({ input: 2.5, output: 15, cacheWrite: 3.125, cacheRead: 0.25 });
    expect(modelPrices("gpt-5.6-luna")).toEqual({ input: 1, output: 6, cacheWrite: 1.25, cacheRead: 0.1 });
  });

  test("prices the base model id", () => {
    expect(modelPrices("claude-opus-4-8").input).toBe(5);
  });

  test("prices a date-stamped suffix", () => {
    expect(modelPrices("claude-haiku-4-5-20251001").input).toBe(1);
  });

  test("prices a bracketed context-window alias (not metered as free)", () => {
    // claude-opus-4-8[1m] is a real model; it must not fall through to $0.
    const price = modelPrices("claude-opus-4-8[1m]");
    expect(price.input).toBe(5);
    expect(price.output).toBe(25);
  });

  test("applies the published Sonnet 5 introductory window without a future rollover gap", () => {
    const beforeRollover = Date.UTC(2026, 7, 31, 23, 59, 59, 999);
    const atRollover = Date.UTC(2026, 8, 1);
    expect(modelPrices("claude-sonnet-5", beforeRollover)).toEqual({
      input: 2,
      output: 10,
      cacheWrite: 2.5,
      cacheRead: 0.2,
    });
    expect(modelPrices("claude-sonnet-5", atRollover)).toEqual({
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    });
  });

  test("rejects provider features whose extra billing is not statically bounded", () => {
    const estimate = (extra: Record<string, unknown>) => estimateMessagesSpend(
      new TextEncoder().encode(JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [],
        ...extra,
      })).buffer as ArrayBuffer,
    );
    expect(estimate({ inference_geo: "us" }).unsupportedBillingFeature).toBe("inference_geo");
    expect(estimate({ speed: "fast" }).unsupportedBillingFeature).toBe("speed");
    expect(estimate({ service_tier: "auto" }).unsupportedBillingFeature).toBe("service_tier");
    expect(estimate({ tools: [{ type: "web_search_20260209", name: "web_search" }] }).unsupportedBillingFeature)
      .toBe("server_tool");
    expect(estimate({ mcp_servers: [{ url: "https://mcp.example" }] }).unsupportedBillingFeature)
      .toBe("mcp_servers");
    expect(estimate({ container: "container_123" }).unsupportedBillingFeature).toBe("container");
    expect(estimate({
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "https://mutable.example/image" } }],
      }],
    }).unsupportedBillingFeature).toBe("url_source");
    expect(estimate({
      system: [{ type: "text", text: "cached", cache_control: { type: "ephemeral", ttl: "1h" } }],
    }).unsupportedBillingFeature).toBe("cache_control.ttl");
    expect(estimate({
      inference_geo: "global",
      service_tier: "standard_only",
      tools: [{ name: "read", description: "client-side", input_schema: { type: "object" } }],
      cache_control: { type: "ephemeral", ttl: "5m" },
    }).unsupportedBillingFeature).toBeNull();
  });

  test("normalizes safe provider defaults and preflights provider-expanded inputs", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
    const plain = prepareMessagesRequest(encode({
      model: "claude-sonnet-4-6",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    }));
    expect(JSON.parse(new TextDecoder().decode(plain.body))).toMatchObject({
      service_tier: "standard_only",
      inference_geo: "global",
    });
    expect(plain.countTokensBody).toBeNull();

    const withTool = prepareMessagesRequest(encode({
      model: "claude-sonnet-4-6",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "read", description: "read a file", input_schema: { type: "object" } }],
    }));
    expect(withTool.countTokensBody).not.toBeNull();
    const countInput = JSON.parse(new TextDecoder().decode(withTool.countTokensBody!));
    expect(countInput).toMatchObject({ model: "claude-sonnet-4-6", tools: [{ name: "read" }] });
    expect(countInput).not.toHaveProperty("max_tokens");
    expect(countInput).not.toHaveProperty("service_tier");
    expect(countInput).not.toHaveProperty("inference_geo");

    const estimate = estimateMessagesSpend(withTool.body, Date.now(), 403);
    expect(estimate.inputTokenUpperBound).toBe(8_998);
    expect(estimate.unsupportedBillingFeature).toBeNull();
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

    // Deliberately conservative unknown-model rates: 15 + 75 + 18.75 + 1.5.
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
