import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildOutputValidationDiagnostics, describeReceivedOutput } from "../src/output-validation-diagnostics.js";

describe("describeReceivedOutput", () => {
    test("reports top-level keys for a plain object", () => {
        const described = describeReceivedOutput({ topic: "report", extra: 1 });
        expect(described.receivedKeys).toEqual(["topic", "extra"]);
        expect(described.receivedDescription).toBe("received value top-level keys: [topic, extra]");
    });

    test("reports an object with no top-level keys explicitly", () => {
        const described = describeReceivedOutput({});
        expect(described.receivedKeys).toEqual([]);
        expect(described.receivedDescription).toBe("received value is an object with no top-level keys");
    });

    test("caps the key list for very wide objects but keeps every key in receivedKeys", () => {
        const wide = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`k${index}`, index]));
        const described = describeReceivedOutput(wide);
        expect(described.receivedKeys).toHaveLength(25);
        expect(described.receivedDescription).toContain("k0");
        expect(described.receivedDescription).toContain("+5 more");
        expect(described.receivedDescription).not.toContain("k24");
    });

    test("describes an array with its length instead of keys", () => {
        const described = describeReceivedOutput([{ a: 1 }, { a: 2 }]);
        expect(described.receivedKeys).toBeNull();
        expect(described.receivedDescription).toBe("received value is an array of 2 element(s), not an object");
    });

    test("describes null and undefined explicitly", () => {
        expect(describeReceivedOutput(null)).toEqual({ receivedKeys: null, receivedDescription: "received value is null" });
        expect(describeReceivedOutput(undefined)).toEqual({ receivedKeys: null, receivedDescription: "received value is undefined" });
    });

    test("previews primitives and truncates long ones", () => {
        const short = describeReceivedOutput(42);
        expect(short.receivedKeys).toBeNull();
        expect(short.receivedDescription).toBe("received value is a number (42), not an object");
        const long = describeReceivedOutput("x".repeat(200));
        expect(long.receivedDescription).toContain("received value is a string");
        expect(long.receivedDescription).toContain("…");
        expect(long.receivedDescription.length).toBeLessThan(160);
    });
});

describe("buildOutputValidationDiagnostics", () => {
    test("summarizes zod issue paths with expected data plus the received keys", () => {
        const schema = z.object({ total: z.number(), passed: z.boolean() });
        const parsed = schema.safeParse({ topic: "quarterly" });
        expect(parsed.success).toBe(false);
        const diagnostics = buildOutputValidationDiagnostics(parsed.error, { topic: "quarterly" });
        expect(diagnostics.receivedKeys).toEqual(["topic"]);
        expect(diagnostics.summary).toContain("total:");
        expect(diagnostics.summary).toContain("passed:");
        expect(diagnostics.summary).toContain("expected number");
        expect(diagnostics.summary).toContain("received value top-level keys: [topic]");
    });

    test("labels root-level issues and describes a non-object payload", () => {
        const parsed = z.object({ value: z.number() }).safeParse("plain");
        expect(parsed.success).toBe(false);
        const diagnostics = buildOutputValidationDiagnostics(parsed.error, "plain");
        expect(diagnostics.receivedKeys).toBeNull();
        expect(diagnostics.summary).toContain("(root):");
        expect(diagnostics.summary).toContain('received value is a string ("plain"), not an object');
    });

    test("caps the summarized issue list and counts the overflow", () => {
        const shape = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`f${index}`, z.number()]));
        const parsed = z.object(shape).safeParse({});
        expect(parsed.success).toBe(false);
        const diagnostics = buildOutputValidationDiagnostics(parsed.error, {});
        expect(diagnostics.summary).toContain("f0:");
        expect(diagnostics.summary).toContain("+3 more issue(s)");
    });

    test("appends structured expected/received fields when the issue message lacks them", () => {
        const diagnostics = buildOutputValidationDiagnostics({
            issues: [{ path: ["value"], message: "bad shape", expected: "number", received: "string" }],
        }, 3);
        expect(diagnostics.summary).toContain("value: bad shape (expected number, received string)");
    });

    test("falls back to the error message when no issues are present", () => {
        const diagnostics = buildOutputValidationDiagnostics(new Error("boom"), null);
        expect(diagnostics.summary).toBe("boom; received value is null");
    });
});
