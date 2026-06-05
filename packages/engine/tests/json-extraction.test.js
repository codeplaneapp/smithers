import { describe, expect, test } from "bun:test";
import { extractLastBalancedJson } from "../src/json-extraction.js";

describe("JSON extraction", () => {
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
