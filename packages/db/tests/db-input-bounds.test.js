import { describe, expect, test } from "bun:test";
import { assertJsonPayloadWithinBounds, assertMaxBytes, assertMaxJsonDepth } from "../src/input-bounds.js";

describe("input bounds validators", () => {
    test("assertMaxBytes accepts strings and byte buffers and rejects oversized values", () => {
        expect(assertMaxBytes("payload", "é", 2)).toBe(2);
        expect(assertMaxBytes("payload", new Uint8Array([1, 2, 3]), 3)).toBe(3);
        expect(() => assertMaxBytes("payload", "abcd", 3)).toThrow(/maximum size/);
        expect(() => assertMaxBytes("payload", 123, 3)).toThrow(/string or byte buffer/);
    });

    test("assertMaxJsonDepth rejects deep and circular values", () => {
        expect(() => assertMaxJsonDepth("payload", { a: { b: true } }, 2)).toThrow(/maximum JSON depth/);
        const circular = {};
        circular.self = circular;
        expect(() => assertMaxJsonDepth("payload", circular, 5)).toThrow(/circular references/);
    });

    test("assertJsonPayloadWithinBounds returns JSON for bounded payloads", () => {
        expect(assertJsonPayloadWithinBounds("payload", { tags: ["ok"], title: "hi" }, {
            maxBytes: 64,
            maxDepth: 3,
            maxArrayLength: 2,
            maxStringLength: 5,
        })).toBe("{\"tags\":[\"ok\"],\"title\":\"hi\"}");
    });

    test("assertJsonPayloadWithinBounds rejects JSON error paths", () => {
        expect(() => assertJsonPayloadWithinBounds("payload", { title: "toolong" }, { maxStringLength: 3 })).toThrow(/string exceeding/);
        expect(() => assertJsonPayloadWithinBounds("payload", [1, 2, 3], { maxArrayLength: 2 })).toThrow(/array exceeding/);
        expect(() => assertJsonPayloadWithinBounds("payload", { value: Number.POSITIVE_INFINITY }, {})).toThrow(/finite numbers/);
        expect(() => assertJsonPayloadWithinBounds("payload", { value: undefined }, {})).toThrow(/JSON-serializable/);
    });
});
