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
