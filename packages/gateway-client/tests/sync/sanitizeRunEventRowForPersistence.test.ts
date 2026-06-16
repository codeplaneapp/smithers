import { describe, expect, test } from "bun:test";
import {
  MAX_PERSISTED_EVENT_PAYLOAD_CHARS,
  sanitizeRunEventRowForPersistence,
} from "../../src/sync/sanitizeRunEventRowForPersistence.ts";
import type { GatewayRunEventRow } from "../../src/sync/GatewayRunEventRow.ts";

describe("sanitizeRunEventRowForPersistence", () => {
  test("keeps small control-plane payloads intact", () => {
    const row: GatewayRunEventRow = { key: ["run", "r1"], seq: 1, event: "run.started", payload: { state: "running" } };
    expect(sanitizeRunEventRowForPersistence(row)).toBe(row);
  });

  test("drops oversized blob payloads to a truncation marker", () => {
    const big = "x".repeat(MAX_PERSISTED_EVENT_PAYLOAD_CHARS + 100);
    const row: GatewayRunEventRow = { key: ["run", "r1"], seq: 2, event: "node.output", payload: { output: big } };
    const out = sanitizeRunEventRowForPersistence(row);
    expect(out.seq).toBe(2);
    expect(out.event).toBe("node.output");
    expect(out.payload).toMatchObject({ $truncated: true });
    // The persisted row is now tiny — the blob never reaches the durable cache.
    expect(JSON.stringify(out).length).toBeLessThan(big.length);
  });

  test("leaves null/undefined payloads untouched and truncates unserializable ones", () => {
    const nullRow: GatewayRunEventRow = { key: ["x"], seq: 3, event: "e", payload: null };
    expect(sanitizeRunEventRowForPersistence(nullRow)).toBe(nullRow);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = sanitizeRunEventRowForPersistence({ key: ["x"], seq: 4, event: "e", payload: circular });
    expect(out.payload).toMatchObject({ $truncated: true });
  });
});
