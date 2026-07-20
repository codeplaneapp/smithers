import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const skill = readFileSync(resolve(import.meta.dir, "../../../skills/eval-writer/SKILL.md"), "utf8");

describe("eval-writer skill scorer API examples", () => {
    test("documents LLM scorer APIs with their real scorer signatures", () => {
        expect(skill).toContain("faithfulnessScorer(claude)");
        expect(skill).toContain("relevancyScorer(claude)");
        expect(skill).toContain("judge: claude");
        expect(skill).toContain("instructions:");
        expect(skill).toContain("promptTemplate:");
        expect(skill).toContain('sampling: { type: "ratio", rate: 0.1 }');

        expect(skill).not.toContain("faithfulnessScorer()");
        expect(skill).not.toContain("relevancyScorer()");
        expect(skill).not.toContain("model:");
        expect(skill).not.toContain("prompt:");
        expect(skill).not.toContain("kind:");
        expect(skill).not.toContain("ratio:");
    });
});
