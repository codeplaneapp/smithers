/**
 * Unit tests for installAgentIntegration — init's "plugin, or skill if no
 * plugin" step for the preferred agent. The agent CLI runner is injected
 * (bun test cannot capture child-process output in every sandbox), and skill
 * installs land in a temp $HOME.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_PLUGIN_SPEC, installAgentIntegration } from "../src/init/installAgentIntegration.js";

function tempHome(agentDirs = []) {
    const home = mkdtempSync(join(tmpdir(), "smithers-integration-"));
    for (const dir of agentDirs) {
        mkdirSync(join(home, dir), { recursive: true });
    }
    return home;
}

describe("installAgentIntegration", () => {
    test("claude gets the marketplace plugin when the claude CLI cooperates", () => {
        const home = tempHome([".claude"]);
        const calls = [];
        try {
            const result = installAgentIntegration({
                agentId: "claude",
                env: {},
                homeDir: home,
                detections: [],
                runCommand: (command, args) => {
                    calls.push([command, ...args].join(" "));
                    return { ok: true, output: "" };
                },
            });
            expect(result.kind).toBe("plugin");
            expect(result.ok).toBe(true);
            expect(result.detail).toContain(CLAUDE_PLUGIN_SPEC);
            expect(calls.some((call) => call.includes("plugin marketplace add"))).toBe(true);
            expect(calls.some((call) => call.includes(`plugin install ${CLAUDE_PLUGIN_SPEC}`))).toBe(true);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test("claude falls back to the curated skill when the plugin install fails", () => {
        const home = tempHome([".claude"]);
        try {
            const result = installAgentIntegration({
                agentId: "claude",
                env: {},
                homeDir: home,
                detections: [],
                runCommand: () => ({ ok: false, output: "command not found: claude" }),
            });
            expect(result.kind).toBe("skill");
            expect(result.ok).toBe(true);
            expect(result.fallback).toBe(true);
            expect(existsSync(join(home, ".claude", "skills", "smithers", "SKILL.md"))).toBe(true);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test("codex gets the curated skill in ~/.codex/skills (no plugin path)", () => {
        const home = tempHome([".codex"]);
        try {
            const result = installAgentIntegration({
                agentId: "codex",
                env: {},
                homeDir: home,
                detections: [],
                runCommand: () => {
                    throw new Error("no CLI should run for a skill-tier agent");
                },
            });
            expect(result.kind).toBe("skill");
            expect(result.ok).toBe(true);
            expect(existsSync(join(home, ".codex", "skills", "smithers", "SKILL.md"))).toBe(true);
            expect(existsSync(join(home, ".codex", "skills", "smithers", "llms-full.txt"))).toBe(true);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test("a skill-tier agent that is not present reports the miss without failing", () => {
        const home = tempHome();
        try {
            const result = installAgentIntegration({
                agentId: "pi",
                env: {},
                homeDir: home,
                detections: [],
            });
            expect(result.kind).toBe("none");
            expect(result.ok).toBe(false);
            expect(result.detail).toContain("not-detected");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test("an agent with no known integration reports 'none' as ok", () => {
        const home = tempHome();
        try {
            const result = installAgentIntegration({
                agentId: "openrouter",
                env: {},
                homeDir: home,
                detections: [],
            });
            expect(result.kind).toBe("none");
            expect(result.ok).toBe(true);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
