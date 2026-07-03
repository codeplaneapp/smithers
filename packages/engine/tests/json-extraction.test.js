import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractBalancedJson, extractLastBalancedJson } from "../src/json-extraction.js";

describe("JSON extraction", () => {
    test("extractBalancedJson keeps escaped quotes inside strings without a dead quote guard", () => {
        const sourcePath = fileURLToPath(new URL("../src/json-extraction.js", import.meta.url));
        const source = readFileSync(sourcePath, "utf8");
        expect(source).not.toContain('c === \'"\' && !escape');

        const extracted = extractBalancedJson('prefix {"message":"say \\"hello\\" {still string}","ok":true} suffix');
        expect(JSON.parse(extracted)).toEqual({
            message: 'say "hello" {still string}',
            ok: true,
        });
    });

    test("extracts the outer final JSON object after prose when it contains nested objects", () => {
        const text = `I've reviewed the implementation and found a couple of issues.

{
  "approved": false,
  "summary": "request changes",
  "issues": [
    {
      "severity": "major",
      "title": "First issue",
      "recommendation": {
        "action": "update tests",
        "references": ["packages/engine/src/engine.js"]
      }
    },
    {
      "severity": "minor",
      "title": "Doc drift",
      "file": "docs/architecture/activity.md",
      "recommendation": "Update the docs."
    }
  ]
}`;

        const extracted = extractLastBalancedJson(text);
        expect(extracted).not.toBeNull();
        expect(JSON.parse(extracted)).toEqual({
            approved: false,
            summary: "request changes",
            issues: [
                {
                    severity: "major",
                    title: "First issue",
                    recommendation: {
                        action: "update tests",
                        references: ["packages/engine/src/engine.js"],
                    },
                },
                {
                    severity: "minor",
                    title: "Doc drift",
                    file: "docs/architecture/activity.md",
                    recommendation: "Update the docs.",
                },
            ],
        });
    });
});

describe("extractLastBalancedJson — semantics preserved by the single-pass rewrite", () => {
    test("returns the trailing top-level object, not an earlier one", () => {
        expect(extractLastBalancedJson('{"a":1} noise {"b":2}')).toBe('{"b":2}');
    });

    test("prefers the outer object when it closes last", () => {
        expect(extractLastBalancedJson('{"a":{"b":1}}')).toBe('{"a":{"b":1}}');
    });

    test("falls back to the deepest closed object when the encloser never closes", () => {
        expect(extractLastBalancedJson('{"a":{"b":1}')).toBe('{"b":1}');
    });

    test("ignores braces inside strings and escaped quotes", () => {
        expect(extractLastBalancedJson('{"m":"a { b } \\" c"}')).toBe('{"m":"a { b } \\" c"}');
    });

    test("returns null when there is no balanced object", () => {
        expect(extractLastBalancedJson("no json here { unclosed")).toBeNull();
        expect(extractLastBalancedJson("")).toBeNull();
    });

    test("runs in linear time on a large prose payload (hot path — no O(n^2) blowup)", () => {
        // ~200KB of prose sprinkled with many unbalanced `{`, then the real answer.
        const noise = "some prose with a stray { brace ".repeat(6_000);
        const payload = `${noise}\nFinal answer:\n{"verdict":"done","n":42}`;
        const start = performance.now();
        const extracted = extractLastBalancedJson(payload);
        const elapsed = performance.now() - start;
        expect(JSON.parse(extracted)).toEqual({ verdict: "done", n: 42 });
        // The old O(n^2) version blocked ~1.7s on 200KB; linear is milliseconds.
        expect(elapsed).toBeLessThan(500);
    });
});
