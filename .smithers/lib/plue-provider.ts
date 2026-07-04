// smithers-source: authored
//
// A SandboxProvider that runs a smithers child workflow on plue infrastructure:
// `plue workspace create` boots a real Freestyle VM (via plue's control
// plane), we SSH in, bootstrap bun + the claude/codex CLIs, ship a
// self-contained mini-project (the child workflow's source + agents.ts +
// input.json), run it with `bunx --bun smithers-orchestrator up`, and map the
// remote run's result back into the inline SandboxProviderResult shape.
//
// No side effects at import time: nothing here shells out or touches the
// filesystem until `run()` is called, so `smithers graph` and other
// import-only tooling work on machines without a `plue` binary on PATH.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
	SandboxProvider,
	SandboxProviderRequest,
	SandboxProviderResult,
} from "smithers-orchestrator/sandbox";

export type PlueSandboxProviderOptions = {
	/** Path to the plue CLI binary. Defaults to env PLUE_BIN or "plue". */
	plueBin?: string;
	/** "owner/repo" the workspace is bound to. Required. */
	repo: string;
	/** Workspace display name. A unique name is generated if omitted. */
	workspaceName?: string;
	/** Keep the workspace alive after the run instead of deleting it. */
	keepWorkspace?: boolean;
	/** smithers-orchestrator version installed on the remote VM. */
	orchestratorVersion?: string;
	/** Install bun/claude/codex CLIs on the remote VM if missing. */
	bootstrapAgents?: boolean;
	/** Extra env vars forwarded to the remote run (never logged). */
	env?: Record<string, string>;
	/** How often to poll workspace status while waiting for it to boot. */
	pollIntervalMs?: number;
	/** How long to wait for the workspace to reach "running" with SSH ready. */
	bootTimeoutMs?: number;
	/**
	 * Reuse an existing (already-running) workspace by id instead of creating a
	 * fresh one. Fresh Freestyle VM boots are occasionally flaky (status→failed);
	 * pointing at a known-good warm workspace makes e2e/demo runs deterministic.
	 * When set, the workspace is never deleted on cleanup regardless of
	 * keepWorkspace.
	 */
	existingWorkspaceId?: string;
};

export type PlueChildInput = {
	scriptSource: string;
	scriptName: string;
	childInput?: unknown;
};

type WorkspaceCreateResult = {
	id: string;
	[key: string]: unknown;
};

type WorkspaceViewResult = {
	id: string;
	status: string;
	ssh?: {
		command?: string;
	};
	[key: string]: unknown;
};

export type SshTarget = {
	/** user@host (or host), suitable as the ssh(1) destination argument. */
	destination: string;
	/** Extra flags from the plue-provided ssh command (e.g. -p 2222, -i key). */
	extraArgs: string[];
};

/**
 * Parse a `ssh ...` command string (as returned by `plue workspace view
 * --format json` in `.ssh.command`) into a destination + extra args, so we
 * can re-run it non-interactively with our own flags
 * (-o BatchMode=yes -o StrictHostKeyChecking=accept-new).
 */
export function parseSshCommand(command: string): SshTarget {
	const tokens = tokenizeShellCommand(command.trim());
	if (tokens.length === 0 || tokens[0] !== "ssh") {
		throw new Error(`Expected an ssh command, got: ${command}`);
	}
	const rest = tokens.slice(1);
	const extraArgs: string[] = [];
	let destination: string | undefined;
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		if (token === "-o" || token === "-p" || token === "-i" || token === "-l") {
			extraArgs.push(token, rest[i + 1] ?? "");
			i += 1;
			continue;
		}
		if (token.startsWith("-")) {
			extraArgs.push(token);
			continue;
		}
		destination = token;
	}
	if (!destination) {
		throw new Error(`Could not find ssh destination in command: ${command}`);
	}
	return { destination, extraArgs };
}

function tokenizeShellCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === " " || ch === "\t") {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current.length > 0) {
		tokens.push(current);
	}
	return tokens;
}

/**
 * Sanitize a candidate workspace name to plue's allowed charset (lowercase
 * alphanumeric + hyphen) and append a short unique suffix so concurrent runs
 * never collide.
 */
export function sanitizeWorkspaceName(candidate: string, unique: string): string {
	const base = candidate
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const suffix = unique.replace(/[^a-z0-9]/g, "").slice(0, 8);
	const trimmedBase = (base || "smithers-run").slice(0, 40);
	return `${trimmedBase}-${suffix}`;
}

/** Build the tarball manifest for the mini-project shipped to the remote VM. */
export function buildRemoteProjectFiles(args: {
	scriptSource: string;
	scriptName: string;
	childInput: unknown;
	orchestratorVersion: string;
}): Record<string, string> {
	const { scriptSource, scriptName, childInput, orchestratorVersion } = args;
	const packageJson = {
		name: "smithers-plue-run",
		private: true,
		type: "module",
		dependencies: {
			"smithers-orchestrator": orchestratorVersion,
			zod: "^4",
		},
	};
	const agentsTs = `import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";

export const claude = new ClaudeCodeAgent({});
export const codex = new CodexAgent({ skipGitRepoCheck: true });
export const agents = { claude, codex };
`;
	return {
		"package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
		"agents.ts": agentsTs,
		[scriptName]: scriptSource,
		"input.json": `${JSON.stringify(childInput ?? {}, null, 2)}\n`,
	};
}

type RemoteRunOutcome = {
	status: "finished" | "failed";
	output: unknown;
	remoteRunId?: string;
};

/**
 * The typed envelope this provider publishes as the Sandbox task's output. The
 * engine validates the task output against the workflow's declared output
 * schema, and `materializeProviderResult` (in packages/sandbox) treats the
 * provider result's `outputs` field as that task output. So the provider MUST
 * put this envelope in `outputs` — returning only `output` (the child's raw,
 * schema-less output) makes the declared `{status,...}` schema fail to validate.
 */
export type PlueRunEnvelope = {
	status: "finished" | "failed";
	output: unknown;
	remoteRunId: string | null;
	workspaceId: string | null;
};

/** Wrap a remote-run outcome into the provider result the engine expects. */
export function toProviderResult(
	outcome: RemoteRunOutcome,
	workspaceId: string | null,
): {
	status: "finished" | "failed";
	outputs: PlueRunEnvelope;
	remoteRunId?: string;
	workspaceId?: string;
} {
	const envelope: PlueRunEnvelope = {
		status: outcome.status,
		output: outcome.output,
		remoteRunId: outcome.remoteRunId ?? null,
		workspaceId,
	};
	return {
		status: outcome.status,
		outputs: envelope,
		...(outcome.remoteRunId ? { remoteRunId: outcome.remoteRunId } : {}),
		...(workspaceId ? { workspaceId } : {}),
	};
}

/**
 * Extract the child runId that `smithers up` prints (a line like
 * `runId: run-1782960347605` OR a bare UUID `runId: 820007c0-65c8-...` — the
 * id scheme differs by backend/env). Returns undefined if not found.
 */
export function extractRemoteRunId(upStdout: string): string | undefined {
	const match = upStdout.match(/(?:^|\n)\s*runId:\s*([A-Za-z0-9-]+)/);
	return match ? match[1] : undefined;
}

/**
 * Determine the child run's terminal status from the FOREGROUND `smithers up`
 * output, which prints a `status: <state>` line once the run completes. This is
 * authoritative (up blocks until terminal), so we prefer it over a follow-up
 * inspect that can race id-scheme quirks. Returns "finished" for
 * finished/completed/succeeded, otherwise "failed".
 */
export function parseUpStatus(upStdout: string): "finished" | "failed" {
	const match = upStdout.match(/(?:^|\n)\s*status:\s*([A-Za-z-]+)/);
	const state = match ? match[1].toLowerCase() : "";
	return state === "finished" || state === "completed" || state === "succeeded"
		? "finished"
		: "failed";
}

function execFileAsync(
	command: string,
	args: string[],
	options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ timeout: options.timeout, env: options.env, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					reject(Object.assign(error, { stdout, stderr }));
					return;
				}
				resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
			},
		);
	});
}

async function runSsh(
	target: SshTarget,
	remoteCommand: string,
	options: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	const args = [
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=accept-new",
		...target.extraArgs,
		target.destination,
		remoteCommand,
	];
	return execFileAsync("ssh", args, options);
}

function base64Tar(files: Record<string, string>): string {
	// Not a real tar — a simple length-prefixed archive the remote unpack
	// script below understands. Avoids depending on tar being present locally.
	const parts: string[] = [];
	for (const [name, content] of Object.entries(files)) {
		const encoded = Buffer.from(content, "utf8").toString("base64");
		parts.push(`${name}\n${encoded.length}\n${encoded}`);
	}
	return Buffer.from(parts.join("\n---FILE---\n"), "utf8").toString("base64");
}

function buildUnpackScript(remoteDir: string, archiveB64: string): string {
	return [
		`mkdir -p ${remoteDir}`,
		`cd ${remoteDir}`,
		`echo '${archiveB64}' | base64 -d > .smithers-plue-archive.txt`,
		`node -e "` +
			`const fs=require('fs');` +
			`const raw=fs.readFileSync('.smithers-plue-archive.txt','utf8');` +
			`for (const chunk of raw.split('\\n---FILE---\\n')) {` +
			`const lines=chunk.split('\\n');` +
			`const name=lines[0];` +
			`const len=parseInt(lines[1],10);` +
			`const b64=chunk.slice(lines[0].length+1+lines[1].length+1, chunk.length);` +
			`fs.writeFileSync(name, Buffer.from(b64,'base64'));` +
			`}` +
			`"`,
		`rm -f .smithers-plue-archive.txt`,
	].join(" && ");
}

// Exported so a unit test can assert it tracks the repo's root package.json
// version — the release bump/publish flow edits package.json, not this literal,
// so without the gate a bump would leave the remote VM on a stale orchestrator.
export const DEFAULT_ORCHESTRATOR_VERSION = "0.27.0";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BOOT_TIMEOUT_MS = 6 * 60_000;
const REMOTE_DIR = "/home/developer/smithers-plue-run";

/**
 * Prefix every remote run command with this so it picks up the Claude OAuth
 * env staged by `plue workspace exec --seed-agent-auth` (if present) ahead
 * of bun/agent binaries on PATH. Verified end-to-end in a live VM: plain
 * ANTHROPIC_API_KEY / OPENAI_API_KEY env vars are unreliable (a dead API key
 * shadows a working subscription OAuth token; `codex exec` ignores
 * OPENAI_API_KEY entirely), so agent auth is seeded via the plue CLI's own
 * mechanism instead of injected as plaintext env vars.
 */
export const REMOTE_AUTH_PREFIX =
	'[ -f ~/.smithers/claude-env.sh ] && . ~/.smithers/claude-env.sh; export PATH="$HOME/.bun/bin:$PATH"; ';

/** Build the argv for the `plue workspace exec --seed-agent-auth` call that
 * stages Claude + Codex auth on the remote VM. Never pass secrets on this
 * command line — it only names the agents to seed. */
export function buildSeedAgentAuthArgs(workspaceId: string, repo: string): string[] {
	return [
		"workspace",
		"exec",
		workspaceId,
		"--repo",
		repo,
		"--seed-agent-auth",
		"claude,codex",
		"--timeout",
		"60",
		"--command",
		"true",
	];
}

export function createPlueSandboxProvider(options: PlueSandboxProviderOptions): SandboxProvider {
	const plueBin = options.plueBin ?? process.env.PLUE_BIN ?? "plue";
	const orchestratorVersion = options.orchestratorVersion ?? DEFAULT_ORCHESTRATOR_VERSION;
	const bootstrapAgents = options.bootstrapAgents ?? true;
	const keepWorkspace = options.keepWorkspace ?? false;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;

	const workspaceIdByKey = new Map<string, string>();

	async function createWorkspace(name: string): Promise<string> {
		const { stdout } = await execFileAsync(plueBin, [
			"workspace",
			"create",
			"--repo",
			options.repo,
			"--name",
			name,
			"--format",
			"json",
		]);
		const parsed = JSON.parse(stdout) as WorkspaceCreateResult;
		if (!parsed?.id) {
			throw new Error(`plue workspace create did not return an id: ${stdout}`);
		}
		return parsed.id;
	}

	async function viewWorkspace(id: string): Promise<WorkspaceViewResult> {
		const { stdout } = await execFileAsync(plueBin, [
			"workspace",
			"view",
			id,
			"--repo",
			options.repo,
			"--format",
			"json",
		]);
		return JSON.parse(stdout) as WorkspaceViewResult;
	}

	async function waitForRunning(
		id: string,
		request: SandboxProviderRequest,
	): Promise<WorkspaceViewResult> {
		const deadline = Date.now() + bootTimeoutMs;
		for (;;) {
			const view = await viewWorkspace(id);
			request.heartbeat({ stage: "waiting-for-workspace", workspaceId: id, status: view.status });
			if (view.status === "running" && view.ssh?.command) {
				return view;
			}
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for workspace ${id} to become ready (status=${view.status})`);
			}
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
	}

	async function bootstrap(target: SshTarget, request: SandboxProviderRequest): Promise<void> {
		request.heartbeat({ stage: "bootstrap-start" });
		await runSsh(
			target,
			`command -v bun >/dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash)`,
			{ timeout: 3 * 60_000 },
		);
		if (bootstrapAgents) {
			await runSsh(
				target,
				`export PATH="$HOME/.bun/bin:$PATH"; command -v claude >/dev/null 2>&1 || bun i -g @anthropic-ai/claude-code`,
				{ timeout: 3 * 60_000 },
			);
			await runSsh(
				target,
				`export PATH="$HOME/.bun/bin:$PATH"; command -v codex >/dev/null 2>&1 || bun i -g @openai/codex`,
				{ timeout: 3 * 60_000 },
			);
		}
		request.heartbeat({ stage: "bootstrap-done" });
	}

	// Extra env overrides (options.env) travel as a 0600 file on the remote
	// VM, never as plain env params on any logged command line. Agent auth
	// itself (Claude / Codex) is NOT seeded here — see seedAgentAuth below,
	// which delegates to the plue CLI's own OAuth-first auth-seeding
	// (verified end-to-end in a live VM: plain ANTHROPIC_API_KEY /
	// OPENAI_API_KEY env vars fail on hosts without API credits / with codex
	// exec ignoring OPENAI_API_KEY).
	async function writeRemoteEnvFile(target: SshTarget, extraEnv: Record<string, string>): Promise<string> {
		const envPath = `${REMOTE_DIR}/.env.plue-run`;
		const lines = Object.entries(extraEnv)
			.filter(([, value]) => value.length > 0)
			.map(([key, value]) => `${key}=${value}`);
		const b64 = Buffer.from(lines.join("\n"), "utf8").toString("base64");
		await runSsh(
			target,
			`mkdir -p ${REMOTE_DIR} && echo '${b64}' | base64 -d > ${envPath} && chmod 600 ${envPath}`,
		);
		return envPath;
	}

	/**
	 * Seed Claude + Codex auth into the workspace via the plue CLI itself
	 * (never via plain ANTHROPIC_API_KEY / OPENAI_API_KEY env vars, which are
	 * unreliable: an API key without credits shadows a working subscription
	 * OAuth token for Claude, and `codex exec` ignores OPENAI_API_KEY
	 * entirely). This stages `~/.smithers/claude-env.sh` and
	 * `~/.codex/auth.json` (mode 0600) on the remote VM. Never log this
	 * command's output — treat it as sensitive.
	 */
	async function seedAgentAuth(workspaceId: string, request: SandboxProviderRequest): Promise<void> {
		request.heartbeat({ stage: "seeding-agent-auth", workspaceId });
		await execFileAsync(plueBin, buildSeedAgentAuthArgs(workspaceId, options.repo), {
			timeout: 90_000,
		});
	}

	return {
		id: "plue",
		async run(request: SandboxProviderRequest): Promise<SandboxProviderResult> {
			if (!options.repo) {
				throw new Error('createPlueSandboxProvider requires options.repo ("owner/repo")');
			}
			const input = (request.input ?? {}) as Partial<PlueChildInput>;
			if (typeof input.scriptSource !== "string" || typeof input.scriptName !== "string") {
				throw new Error(
					"plue sandbox provider requires input.scriptSource and input.scriptName",
				);
			}

			const name = sanitizeWorkspaceName(
				options.workspaceName ?? `plue-run-${request.sandboxId}`,
				`${request.runId}${randomUUID()}`,
			);

			// Reuse a warm workspace when asked (flaky fresh boots); otherwise
			// create one. A reused workspace is never deleted on cleanup.
			const reusing = Boolean(options.existingWorkspaceId);
			let workspaceId: string;
			if (options.existingWorkspaceId) {
				workspaceId = options.existingWorkspaceId;
				request.heartbeat({ stage: "reusing-workspace", workspaceId });
			} else {
				request.heartbeat({ stage: "creating-workspace", name });
				workspaceId = await createWorkspace(name);
			}
			// The map is only a crash-time safety net for deletion in cleanup().
			// A reused workspace is never ours to delete; a kept workspace must
			// survive the run, so neither is registered — otherwise the executor's
			// unconditional cleanup() would delete a workspace the caller asked to
			// keep.
			if (!reusing && !keepWorkspace) {
				workspaceIdByKey.set(`${request.runId}:${request.sandboxId}`, workspaceId);
			}

			try {
				const view = await waitForRunning(workspaceId, request);
				const target = parseSshCommand(view.ssh?.command ?? "");

				await bootstrap(target, request);
				await seedAgentAuth(workspaceId, request);

				const files = buildRemoteProjectFiles({
					scriptSource: input.scriptSource,
					scriptName: input.scriptName,
					childInput: input.childInput,
					orchestratorVersion,
				});
				const archive = base64Tar(files);
				request.heartbeat({ stage: "shipping-project", workspaceId });
				await runSsh(target, buildUnpackScript(REMOTE_DIR, archive), { timeout: 60_000 });

				const envPath = await writeRemoteEnvFile(target, options.env ?? {});

				request.heartbeat({ stage: "bun-install", workspaceId });
				await runSsh(
					target,
					`${REMOTE_AUTH_PREFIX}cd ${REMOTE_DIR} && bun install`,
					{ timeout: 5 * 60_000 },
				);

				request.heartbeat({ stage: "running-child", workspaceId });
				let logTail = "";
				let runFailed = false;
				let upStdout = "";
				try {
					// Run in the FOREGROUND (no -d): `up` then blocks until the child
					// run reaches a terminal state, so the runId it prints is real and
					// the subsequent inspect sees a finished run. Detached (-d) returns
					// immediately and the inspect races an unfinished run (→ null runId).
					const { stdout, stderr } = await runSsh(
						target,
						`${REMOTE_AUTH_PREFIX}cd ${REMOTE_DIR} && set -a && . ${envPath} && set +a && bunx --bun smithers-orchestrator@${orchestratorVersion} up ${input.scriptName} --input "$(cat input.json)"`,
						{ timeout: request.toolTimeoutMs || 25 * 60_000 },
					);
					upStdout = `${stdout}\n${stderr}`;
					logTail = upStdout.slice(-8_000);
				} catch (error) {
					runFailed = true;
					const err = error as { stdout?: string; stderr?: string; message?: string };
					upStdout = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`;
					logTail = upStdout.slice(-8_000);
				} finally {
					await runSsh(target, `rm -f ${envPath}`).catch(() => {});
				}

				if (runFailed) {
					return toProviderResult(
						{ status: "failed", output: { error: "remote run failed", logTail } },
						workspaceId,
					);
				}

				// `up` ran in the foreground and printed the child's terminal
				// status + runId — that output is authoritative. Enrich with a
				// per-run inspect when possible, but never let a flaky inspect
				// override the status `up` already reported.
				const remoteRunId = extractRemoteRunId(upStdout);
				const upStatus = parseUpStatus(upStdout);

				const { stdout: inspectStdout } = await runSsh(
					target,
					`${REMOTE_AUTH_PREFIX}cd ${REMOTE_DIR} && bunx --bun smithers-orchestrator@${orchestratorVersion} inspect ${remoteRunId ?? ""} --format json`,
					{ timeout: 60_000 },
				).catch((error) => ({ stdout: "", stderr: (error as Error).message }));

				let inspectJson: unknown = null;
				try {
					inspectJson = inspectStdout.trim() ? JSON.parse(inspectStdout) : null;
				} catch {
					inspectJson = null;
				}

				const outcome: RemoteRunOutcome = {
					status: upStatus,
					output: inspectJson ?? { logTail },
					remoteRunId,
				};
				return toProviderResult(outcome, workspaceId);
			} finally {
				if (!reusing && !keepWorkspace) {
					await execFileAsync(plueBin, [
						"workspace",
						"delete",
						workspaceId,
						"--repo",
						options.repo,
					]).catch(() => {});
					workspaceIdByKey.delete(`${request.runId}:${request.sandboxId}`);
				}
			}
		},
		async cleanup(request: SandboxProviderRequest): Promise<void> {
			// Honor keepWorkspace even if a workspace was somehow registered: the
			// caller explicitly asked to inspect the VM after the run.
			if (keepWorkspace) return;
			const key = `${request.runId}:${request.sandboxId}`;
			const workspaceId = workspaceIdByKey.get(key);
			if (!workspaceId) {
				return;
			}
			workspaceIdByKey.delete(key);
			await execFileAsync(plueBin, ["workspace", "delete", workspaceId, "--repo", options.repo]).catch(
				() => {},
			);
		},
	};
}
