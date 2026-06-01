import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCliAgentCapabilityReport } from "../src/cli-capabilities/getCliAgentCapabilityReport.js";
import { getCliAgentCapabilityDoctorReport } from "../src/cli-capabilities/getCliAgentCapabilityDoctorReport.js";
import { CLI_AGENT_SURFACE_MANIFEST } from "../src/cli-surface/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("getCliAgentCapabilityReport", () => {
  test("includes opencode in capability discovery", () => {
    const report = getCliAgentCapabilityReport();
    expect(report.map((entry) => entry.id)).toContain("opencode");
  });

  test("covers every CLI surface manifest entry", () => {
    const report = getCliAgentCapabilityReport();
    expect(report.map((entry) => entry.id).sort()).toEqual(
      CLI_AGENT_SURFACE_MANIFEST.map((entry) => entry.id).sort(),
    );
    for (const entry of report) {
      expect(entry.surface.binary).toBe(entry.binary);
      expect(entry.surface.packageExport).toBeTruthy();
      expect(entry.surface.defaultOutputFormat).toBeTruthy();
    }
  });

  test("surface doctor rejects unsupported emitted flags", () => {
    const report = getCliAgentCapabilityDoctorReport();
    expect(report.ok).toBe(true);
    expect(report.issueCount).toBe(0);

    for (const entry of report.agents) {
      const emitted = new Set(entry.surface.emittedFlags);
      for (const unsupported of entry.surface.unsupportedFlags) {
        expect(emitted.has(unsupported.flag)).toBe(false);
      }
    }
  });

  test("Antigravity docs and manifest describe the current agy flag mapping", () => {
    const antigravity = CLI_AGENT_SURFACE_MANIFEST.find((entry) => entry.id === "antigravity");
    expect(antigravity).toBeTruthy();
    expect(antigravity.emittedFlags).toContain("-p");
    expect(antigravity.emittedFlags).toContain("--add-dir");
    expect(antigravity.emittedFlags).toContain("--conversation");
    expect(antigravity.unsupportedFlags.map((entry) => entry.flag)).toEqual(
      expect.arrayContaining(["--output-format", "--include-directories", "--resume", "--screen-reader", "--debug"]),
    );

    const docs = readFileSync(resolve(REPO_ROOT, "docs/integrations/cli-agents.mdx"), "utf8");
    expect(docs).toContain("| `includeDirectories` | `--add-dir` |");
    expect(docs).toContain("| `conversation` / `resume` | `--conversation <id>` |");
    expect(docs).toContain("does not emit `--output-format`");
  });
});
