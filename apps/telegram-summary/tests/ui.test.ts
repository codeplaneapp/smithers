import { describe, expect, test } from "bun:test";
import type { DigestRow } from "../src/service.ts";
import { digestPayload, json, notFound, renderDashboard } from "../src/ui.ts";

function digestRow(overrides: Partial<DigestRow> = {}): DigestRow {
  return {
    id: "digest-1",
    period_start_ms: 1000,
    period_end_ms: 2000,
    message_count: 3,
    model: "kimi-k2.6",
    summary_json: JSON.stringify({ headline: "Hi", summary: "There", topics: [] }),
    telegram_text: "Hi\nThere",
    created_at_ms: 1500,
    posted_at_ms: 1600,
    post_error: null,
    ...overrides,
  };
}

describe("ui", () => {
  test("digestPayload returns null for a null row", () => {
    expect(digestPayload(null)).toBeNull();
  });

  test("digestPayload maps a row and normalizes valid summary json", () => {
    const payload = digestPayload(digestRow());
    expect(payload).not.toBeNull();
    expect(payload?.id).toBe("digest-1");
    expect(payload?.periodStartMs).toBe(1000);
    expect(payload?.periodEndMs).toBe(2000);
    expect(payload?.messageCount).toBe(3);
    expect(payload?.model).toBe("kimi-k2.6");
    expect(payload?.postedAtMs).toBe(1600);
    expect(payload?.telegramText).toBe("Hi\nThere");
    expect((payload?.summary as { headline: string }).headline).toBe("Hi");
  });

  test("digestPayload falls back to an empty digest when summary json is invalid", () => {
    const payload = digestPayload(digestRow({ summary_json: "not json at all", post_error: "boom" }));
    expect((payload?.summary as { headline: string }).headline).toBe("Telegram Daily Summary");
    expect(payload?.postError).toBe("boom");
  });

  test("renderDashboard returns an HTML document", async () => {
    const response = renderDashboard();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("<title>Telegram Summary</title>");
    expect(body).toContain("Latest Summary");
  });

  test("json serializes with json headers and honors init overrides", async () => {
    const response = json({ hello: "world" }, { status: 201, headers: { "x-test": "1" } });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-test")).toBe("1");
    expect(await response.json()).toEqual({ hello: "world" });
  });

  test("notFound returns a 404 text response", async () => {
    const response = notFound();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});
