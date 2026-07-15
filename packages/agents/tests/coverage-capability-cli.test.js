import { describe, expect, test } from "bun:test";
import { normalizeCapabilityRegistry } from "../src/capability-registry/normalizeCapabilityRegistry.js";
import { hashCapabilityRegistry } from "../src/capability-registry/hashCapabilityRegistry.js";
import { formatCliAgentCapabilityDoctorReport } from "../src/cli-capabilities/formatCliAgentCapabilityDoctorReport.js";
import { getCliAgentCapabilityReport } from "../src/cli-capabilities/getCliAgentCapabilityReport.js";
import {
  getCliAgentSurfaceManifestEntry,
  listCliAgentSurfaceManifests,
} from "../src/cli-surface/index.js";
import { createSmithersAgentContract } from "../src/agent-contract/index.js";

/**
 * @param {Partial<any>} [overrides]
 */
function registry(overrides = {}) {
  return {
    version: 1,
    engine: "codex",
    runtimeTools: {},
    mcp: { bootstrap: "project-config", supportsProjectScope: true, supportsUserScope: true },
    skills: { supportsSkills: false, smithersSkillIds: [] },
    humanInteraction: { supportsUiRequests: false, methods: [] },
    builtIns: ["default"],
    ...overrides,
  };
}

describe("normalizeCapabilityRegistry", () => {
  test("returns null for a missing registry", () => {
    expect(normalizeCapabilityRegistry(null)).toBeNull();
    expect(normalizeCapabilityRegistry(undefined)).toBeNull();
  });

  test("sorts + normalizes runtime tool descriptors", () => {
    const normalized = normalizeCapabilityRegistry(
      registry({
        runtimeTools: {
          zeta: { description: "  z  ", source: "builtin" },
          alpha: { description: "", source: undefined },
          beta: null,
        },
      }),
    );
    expect(Object.keys(normalized.runtimeTools)).toEqual(["alpha", "beta", "zeta"]);
    expect(normalized.runtimeTools.zeta).toEqual({ description: "z", source: "builtin" });
    expect(normalized.runtimeTools.alpha).toEqual({ description: undefined, source: undefined });
  });

  test("carries both skills-supported and unsupported shapes", () => {
    const supported = normalizeCapabilityRegistry(
      registry({ skills: { supportsSkills: true, installMode: "copy", smithersSkillIds: ["b", "a"] } }),
    );
    expect(supported.skills).toEqual({
      supportsSkills: true,
      installMode: "copy",
      smithersSkillIds: ["a", "b"],
    });
    const unsupported = normalizeCapabilityRegistry(registry());
    expect(unsupported.skills.supportsSkills).toBe(false);
  });
});

describe("hashCapabilityRegistry", () => {
  test("hashes to a stable sha256 hex and null is stable", () => {
    const h = hashCapabilityRegistry(registry());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCapabilityRegistry(null)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCapabilityRegistry(registry())).toBe(h);
  });

  test("coerces a non-JSON registry value through String()", () => {
    // engine is normally a string; a function forces toStableJson's String()
    // fallback for a value that is neither a primitive, array, nor plain object.
    const h = hashCapabilityRegistry(registry({ engine: /** @type {any} */ (() => 1) }));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("formatCliAgentCapabilityDoctorReport", () => {
  test("summarizes a passing report", () => {
    const report = { ok: true, issueCount: 0, agents: [{ id: "a", capabilities: { engine: "e" }, issues: [] }] };
    expect(formatCliAgentCapabilityDoctorReport(/** @type {any} */ (report))).toContain("passed");
  });
  test("lists issues, skipping clean agents", () => {
    const report = {
      ok: false,
      issueCount: 2,
      agents: [
        { id: "clean", capabilities: { engine: "x" }, issues: [] },
        {
          id: "broken",
          capabilities: { engine: "codex" },
          issues: [{ severity: "error", code: "E1", message: "boom" }],
        },
      ],
    };
    const text = formatCliAgentCapabilityDoctorReport(/** @type {any} */ (report));
    expect(text).toContain("Capability issues found: 2");
    expect(text).toContain("broken (codex)");
    expect(text).toContain("[error] E1: boom");
    expect(text).not.toContain("clean (");
  });
});

describe("cli surface manifest", () => {
  test("looks up entries and lists the full manifest", () => {
    expect(getCliAgentSurfaceManifestEntry("claude")?.binary).toBe("claude");
    expect(getCliAgentSurfaceManifestEntry("does-not-exist")).toBeUndefined();
    const all = listCliAgentSurfaceManifests();
    expect(Array.isArray(all)).toBe(true);
    expect(all.some((entry) => entry.id === "claude")).toBe(true);
  });

  test("getCliAgentCapabilityReport fingerprints every built-in adapter", () => {
    const report = getCliAgentCapabilityReport();
    expect(report.length).toBeGreaterThan(5);
    for (const entry of report) {
      expect(entry.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.surface.id).toBe(entry.id);
    }
  });
});

describe("createSmithersAgentContract categorization", () => {
  test("assigns every category and flags destructive tools", () => {
    const contract = createSmithersAgentContract({
      serverName: "smithers",
      toolSurface: "semantic",
      tools: [
        { name: "list_workflows", description: "list" },
        { name: "workflow_custom", description: "prefix workflow" },
        { name: "resolve_approval", description: "approve a gate" },
        { name: "get_run", description: "run details" },
        { name: "timeline", description: "debug timeline" },
        { name: "replay_run", description: "replay a run from a checkpoint" },
        { name: "memory_query", description: "admin memory" },
        { name: "cancel", description: "stop a run" },
        { name: "risky_thing", description: "Destructive: nukes state" },
        { name: "ask_human", description: "ask a human and wait" },
      ],
    });
    const byName = Object.fromEntries(contract.tools.map((t) => [t.name, t]));
    expect(byName.list_workflows.category).toBe("workflows");
    expect(byName.workflow_custom.category).toBe("workflows");
    expect(byName.resolve_approval.category).toBe("approvals");
    expect(byName.get_run.category).toBe("runs");
    expect(byName.timeline.category).toBe("debug");
    expect(byName.memory_query.category).toBe("admin");
    expect(byName.cancel.destructive).toBe(true);
    expect(byName.replay_run.destructive).toBe(true);
    expect(byName.risky_thing.destructive).toBe(true);
    expect(byName.list_workflows.destructive).toBe(false);
    expect(contract.promptGuidance).toContain("list_workflows");
    expect(contract.promptGuidance).toContain("replay_run");
    expect(contract.docsGuidance).toContain("| `cancel` |");
  });

  test("categorizes the semantic time-travel tools as debug, not admin", () => {
    const contract = createSmithersAgentContract({
      serverName: "smithers",
      toolSurface: "semantic",
      tools: [
        { name: "fork_run", description: "fork a run from a checkpoint" },
        { name: "replay_run", description: "replay a run from a checkpoint" },
        { name: "rewind_run", description: "Destructive: rewind a run" },
        { name: "restore_checkpoint", description: "Destructive: restore a checkpoint" },
        { name: "list_snapshots", description: "list checkpoints for a run" },
        { name: "get_timeline", description: "return the timeline for a run" },
        { name: "time_travel", description: "Destructive: reset a run to a prior attempt" },
      ],
    });
    const byName = Object.fromEntries(contract.tools.map((t) => [t.name, t]));
    for (const name of ["fork_run", "replay_run", "rewind_run", "restore_checkpoint", "list_snapshots", "get_timeline", "time_travel"]) {
      expect(byName[name].category).toBe("debug");
      expect(contract.promptGuidance).toContain(name);
    }
  });
});
