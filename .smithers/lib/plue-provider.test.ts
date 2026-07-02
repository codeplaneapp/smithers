import { describe, expect, test } from "bun:test";
import {
	buildRemoteProjectFiles,
	buildSeedAgentAuthArgs,
	mapRemoteRunResult,
	parseSshCommand,
	REMOTE_AUTH_PREFIX,
	sanitizeWorkspaceName,
} from "./plue-provider.ts";

describe("parseSshCommand", () => {
	test("parses a plain ssh destination", () => {
		const target = parseSshCommand("ssh developer@1.2.3.4");
		expect(target.destination).toBe("developer@1.2.3.4");
		expect(target.extraArgs).toEqual([]);
	});

	test("parses flags and a port", () => {
		const target = parseSshCommand(
			"ssh -p 2222 -o StrictHostKeyChecking=no developer@vm.example.com",
		);
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
		expect(JSON.parse(files["package.json"]).dependencies["smithers-orchestrator"]).toBe(
			"0.26.1",
		);
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

describe("mapRemoteRunResult", () => {
	test("maps a completed run to status finished", () => {
		const outcome = mapRemoteRunResult({ status: "completed", output: { ok: true }, runId: "r1" }, "");
		expect(outcome).toEqual({ status: "finished", output: { ok: true }, remoteRunId: "r1" });
	});

	test("maps a non-completed status to failed with log tail", () => {
		const outcome = mapRemoteRunResult({ status: "errored", runId: "r2" }, "boom");
		expect(outcome.status).toBe("failed");
		expect(outcome.remoteRunId).toBe("r2");
		expect((outcome.output as { logTail: string }).logTail).toBe("boom");
	});

	test("maps missing/invalid json to failed", () => {
		const outcome = mapRemoteRunResult(null, "no output produced");
		expect(outcome.status).toBe("failed");
		expect((outcome.output as { logTail: string }).logTail).toBe("no output produced");
	});
});
