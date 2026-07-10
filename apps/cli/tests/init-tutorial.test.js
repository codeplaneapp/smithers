/**
 * Unit tests for the init tutorial prompt + engine mapping. The tutorial run
 * itself (engine + hijack attach) is exercised by hand and by the hijack e2e
 * suite; here we pin the prompt contract the hijacked agent receives.
 */
import { describe, expect, test } from "bun:test";
import { buildInitTutorialPrompt, tutorialEngineFor } from "../src/init/runInitTutorial.js";

function det(id, displayName, over = {}) {
    return {
        id,
        displayName,
        binary: id,
        hasBinary: true,
        hasAuthSignal: true,
        hasApiKeySignal: false,
        hasProjectTrustSignal: false,
        status: "likely-subscription",
        score: 3,
        usable: true,
        checks: [],
        unusableReasons: [],
        ...over,
    };
}

describe("tutorialEngineFor", () => {
    test("maps hijack-capable detection ids to inline chat engines", () => {
        expect(tutorialEngineFor("claude")).toBe("claude-code");
        expect(tutorialEngineFor("codex")).toBe("codex");
        expect(tutorialEngineFor("pi")).toBe("pi");
        expect(tutorialEngineFor("kimi")).toBe("kimi");
        expect(tutorialEngineFor("amp")).toBe("amp");
        expect(tutorialEngineFor("antigravity")).toBe("antigravity");
    });

    test("agents without native terminal attach get no tutorial engine", () => {
        expect(tutorialEngineFor("opencode")).toBeUndefined();
        expect(tutorialEngineFor("openrouter")).toBeUndefined();
        expect(tutorialEngineFor("hermes")).toBeUndefined();
    });
});

describe("buildInitTutorialPrompt", () => {
    const prompt = buildInitTutorialPrompt({
        cwd: "/repo",
        detections: [
            det("claude", "Claude Code"),
            det("codex", "Codex", { usable: false, unusableReasons: ["not logged in"] }),
        ],
        preferredAgent: det("claude", "Claude Code"),
        integration: { agent: "claude", kind: "plugin", ok: true, detail: "Claude Code plugin smithers@smithersai" },
        workflowCount: 32,
        writtenCount: 120,
        skippedCount: 3,
    });

    test("narrates what was detected", () => {
        expect(prompt).toContain("Claude Code: ready");
        expect(prompt).toContain("Codex: unavailable (not logged in)");
    });

    test("names the preferred agent and its installed integration", () => {
        expect(prompt).toContain("Preferred agent: Claude Code");
        expect(prompt).toContain("native smithers plugin was installed");
    });

    test("summarizes the pack install", () => {
        expect(prompt).toContain("32 workflows");
        expect(prompt).toContain("120 files created");
    });

    test("forbids user selections and pins the hand-back contract", () => {
        expect(prompt).toContain("Never ask the user to select between options");
        expect(prompt).toContain("return ONLY this raw JSON object");
    });

    test("skill-tier integration is narrated as a skill install", () => {
        const skillPrompt = buildInitTutorialPrompt({
            cwd: "/repo",
            detections: [det("codex", "Codex")],
            preferredAgent: det("codex", "Codex"),
            integration: { agent: "codex", kind: "skill", ok: true, detail: "smithers skill → ~/.codex/skills/smithers" },
            workflowCount: 10,
            writtenCount: 0,
            skippedCount: 50,
        });
        expect(skillPrompt).toContain("smithers skill was installed for Codex");
        expect(skillPrompt).toContain("up to date");
    });
});
