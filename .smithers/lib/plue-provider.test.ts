import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildRemoteProjectFiles,
  buildSeedAgentAuthArgs,
  DEFAULT_ORCHESTRATOR_VERSION,
  extractRemoteRunId,
  parseSshCommand,
  parseUpStatus,
  REMOTE_AUTH_PREFIX,
  sanitizeWorkspaceName,
  toProviderResult,
} from "./plue-provider.ts";

describe("parseSshCommand", () => {
  test("parses a plain ssh destination", () => {
    const target = parseSshCommand("ssh developer@1.2.3.4");
    expect(target.destination).toBe("developer@1.2.3.4");
    expect(target.extraArgs).toEqual([]);
  });

  test("parses flags and a port", () => {
    const target = parseSshCommand("ssh -p 2222 -o StrictHostKeyChecking=no developer@vm.example.com");
    expect(target.destination).toBe("developer@vm.example.com");
    expect(target.extraArgs).toEqual(["-p", "2222", "-o", "StrictHostKeyChecking=no"]);
  });

  test("throws on a non-ssh command", () => {
    expect(() => parseSshCommand("scp foo bar")).toThrow();
  });

  test("throws when no destination is present", () => {
    expect(() => parseSshCommand("ssh -p 2222")).toThrow();
  });
});

describe("sanitizeWorkspaceName", () => {
  test("lowercases, strips invalid chars, and appends a unique suffix", () => {
    const name = sanitizeWorkspaceName("Plue Run!!", "abc123xyz0");
    expect(name).toMatch(/^plue-run-[a-z0-9]{8}$/);
  });

  test("falls back to a default base when the candidate sanitizes to empty", () => {
    const name = sanitizeWorkspaceName("###", "abc123");
    expect(name.startsWith("smithers-run-")).toBe(true);
  });

  test("truncates an overly long base", () => {
    const name = sanitizeWorkspaceName("a".repeat(100), "abc12345");
    const [base, suffix] = name.split(/-(?=[a-z0-9]{8}$)/);
    expect(base.length).toBeLessThanOrEqual(40);
    expect(suffix).toHaveLength(8);
  });
});

describe("buildRemoteProjectFiles", () => {
  test("builds package.json, agents.ts, script, and input.json", () => {
    const files = buildRemoteProjectFiles({
      scriptSource: "export default 1;",
      scriptName: "script.tsx",
      childInput: { foo: "bar" },
      orchestratorVersion: "0.26.1",
    });
    expect(files["script.tsx"]).toBe("export default 1;");
    expect(files["input.json"]).toContain('"foo": "bar"');
    expect(JSON.parse(files["package.json"]).dependencies["smithers-orchestrator"]).toBe("0.26.1");
    expect(files["agents.ts"]).toContain("ClaudeCodeAgent");
    expect(files["agents.ts"]).toContain("CodexAgent");
  });

  test("defaults childInput to an empty object", () => {
    const files = buildRemoteProjectFiles({
      scriptSource: "x",
      scriptName: "s.tsx",
      childInput: undefined,
      orchestratorVersion: "0.26.1",
    });
    expect(JSON.parse(files["input.json"])).toEqual({});
  });
});

describe("REMOTE_AUTH_PREFIX", () => {
  test("sources the seeded claude-env.sh before exporting PATH", () => {
    expect(REMOTE_AUTH_PREFIX).toBe(
      '[ -f ~/.smithers/claude-env.sh ] && . ~/.smithers/claude-env.sh; export PATH="$HOME/.bun/bin:$PATH"; ',
    );
  });

  test("never embeds a plaintext API key", () => {
    expect(REMOTE_AUTH_PREFIX).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|sk-/);
  });
});

describe("buildSeedAgentAuthArgs", () => {
  test("builds the plue workspace exec seed-agent-auth argv", () => {
    const args = buildSeedAgentAuthArgs("ws-123", "alice/smoke-test");
    expect(args).toEqual([
      "workspace",
      "exec",
      "ws-123",
      "--repo",
      "alice/smoke-test",
      "--seed-agent-auth",
      "claude,codex",
      "--timeout",
      "60",
      "--command",
      "true",
    ]);
  });

  test("never embeds a plaintext API key or token", () => {
    const args = buildSeedAgentAuthArgs("ws-456", "acme/repo");
    expect(args.join(" ")).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|sk-/);
  });
});

describe("DEFAULT_ORCHESTRATOR_VERSION", () => {
  test("tracks the repo's root package.json version so a release bump can't leave it stale", () => {
    const rootPkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8"));
    expect(DEFAULT_ORCHESTRATOR_VERSION).toBe(rootPkg.version);
  });
});

describe("extractRemoteRunId", () => {
  test("pulls a run-prefixed runId line printed by `smithers up`", () => {
    expect(extractRemoteRunId("...\nrunId: run-1782960347605\nstatus: finished\n")).toBe("run-1782960347605");
  });

  test("pulls a bare-UUID runId (remote id scheme differs)", () => {
    expect(extractRemoteRunId("runId: 820007c0-65c8-4987-9d0c-746fc06e4b04\nstatus: finished\n")).toBe(
      "820007c0-65c8-4987-9d0c-746fc06e4b04",
    );
  });

  test("returns undefined when no runId line is present", () => {
    expect(extractRemoteRunId("nothing here")).toBeUndefined();
  });
});

describe("parseUpStatus", () => {
  test("treats finished/completed/succeeded as finished", () => {
    expect(parseUpStatus("runId: x\nstatus: finished\n")).toBe("finished");
    expect(parseUpStatus("status: completed")).toBe("finished");
    expect(parseUpStatus("status: succeeded")).toBe("finished");
  });

  test("treats anything else (or missing) as failed", () => {
    expect(parseUpStatus("status: errored")).toBe("failed");
    expect(parseUpStatus("no status line")).toBe("failed");
  });
});

describe("toProviderResult", () => {
  // Regression: the Sandbox task output is validated against the workflow's
  // declared schema, and packages/sandbox uses the provider result's `outputs`
  // field as that task output. A result without an `outputs` envelope carrying
  // `status` fails validation (observed live: ZodError on the status enum).
  test("exposes a status-bearing envelope in outputs (success)", () => {
    const result = toProviderResult({ status: "finished", output: { answer: "4" }, remoteRunId: "r1" }, "ws-1");
    expect(result.status).toBe("finished");
    expect(result.outputs).toEqual({
      status: "finished",
      output: { answer: "4" },
      remoteRunId: "r1",
      workspaceId: "ws-1",
    });
    expect(result.remoteRunId).toBe("r1");
    expect(result.workspaceId).toBe("ws-1");
  });

  test("carries the failure envelope so the failed path still validates", () => {
    const result = toProviderResult({ status: "failed", output: { error: "remote run failed" } }, "ws-2");
    expect(result.status).toBe("failed");
    expect(result.outputs.status).toBe("failed");
    expect(result.outputs.workspaceId).toBe("ws-2");
    expect(result.outputs.remoteRunId).toBeNull();
  });
});
