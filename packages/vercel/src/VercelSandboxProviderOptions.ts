import type { SandboxProviderRequest } from "@smithers-orchestrator/sandbox";

/**
 * A minimal structural type for the `@vercel/sandbox` `Sandbox` class (the parts
 * this provider calls). Injected via `options.client` in tests and advanced
 * setups; otherwise resolved by lazily importing `@vercel/sandbox`.
 */
export type VercelSandboxClient = {
	create: (options: Record<string, unknown>) => Promise<VercelSandboxInstance>;
};

/**
 * The subset of a live `@vercel/sandbox` `Sandbox` instance this provider uses.
 */
export type VercelSandboxInstance = {
	/** 1.x id accessor. Absent on 2.x, which exposes the id as `name`. */
	readonly sandboxId?: string;
	/** 2.x id accessor (the sandbox id / name). */
	readonly name?: string;
	writeFiles: (files: Array<{ path: string; content: unknown }>) => Promise<unknown>;
	/** Resolves a Node `ReadableStream` (or `null`) in the real SDK. */
	readFile: (options: { path: string }) => Promise<unknown>;
	runCommand: (options: {
		cmd: string;
		args: string[];
		cwd?: string;
		env?: Record<string, string>;
	}) => Promise<VercelFinishedCommand>;
	extendTimeout?: (ms: number) => Promise<unknown> | unknown;
	domain?: (port: number) => string;
	stop?: () => Promise<unknown> | unknown;
	delete?: () => Promise<unknown> | unknown;
};

/**
 * The finished command returned by `runCommand`. `stdout()`/`stderr()` are async
 * methods (they resolve the captured streams), `exitCode` is a number.
 */
export type VercelFinishedCommand = {
	readonly exitCode?: number;
	stdout: () => Promise<string> | string;
	stderr: () => Promise<string> | string;
};

/**
 * Options for `createVercelSandboxProvider`.
 *
 * Auth precedence: an OIDC token (`options.oidcToken` / `VERCEL_OIDC_TOKEN`) is
 * preferred and is passed as the SDK's `token` field (which "could be an OIDC
 * token or a personal access token"); otherwise an access-token trio
 * (`options.token`/`VERCEL_TOKEN` + `options.teamId`/`VERCEL_TEAM_ID` +
 * `options.projectId`/`VERCEL_PROJECT_ID`) is passed as `{ token, teamId,
 * projectId }`. When none is configured, `Sandbox.create` is called without
 * credentials so the SDK self-discovers them from the environment. Credentials
 * are passed to `Sandbox.create` only and never forwarded into the remote
 * command environment.
 */
export type VercelSandboxProviderOptions = {
	/** Override the provider id (defaults to `vercel-sandbox`). */
	id?: string;
	/** In-sandbox entry command. Defaults to the kit default. */
	command?: string;
	/** Remote working directory. Defaults to `/vercel/sandbox`. */
	workdir?: string;
	/** Remote command environment (never receives local credentials). */
	env?: Record<string, string>;
	/** Teardown behavior handled by the kit: `destroy` (default) or `keep`. */
	cleanup?: "destroy" | "keep";
	/** Inject a `Sandbox`-like factory double (tests / advanced users). */
	client?: VercelSandboxClient;
	/** Vercel runtime image. Defaults to `node24`. */
	runtime?: string;
	/** Requested vCPUs for the sandbox. */
	vcpus?: number;
	/** Declared ports; each is surfaced as a `sandbox.domain(port)` heartbeat. */
	ports?: number[];
	/**
	 * When true, `destroy` stops (pauses) the sandbox instead of deleting it.
	 * Default false: ephemeral sandboxes are deleted permanently on teardown.
	 */
	persist?: boolean;
	/** Explicit session duration in ms; overrides `request.toolTimeoutMs`. */
	timeoutMs?: number;
	/** Plan duration cap in ms. Default 45 minutes. Exceeding it is an error. */
	maxDurationMs?: number;
	/** OIDC token; overrides `VERCEL_OIDC_TOKEN`. Passed to the SDK as `token`. */
	oidcToken?: string;
	/** Access token; overrides `VERCEL_TOKEN`. */
	token?: string;
	/** Team id; overrides `VERCEL_TEAM_ID`. */
	teamId?: string;
	/** Project id; overrides `VERCEL_PROJECT_ID`. */
	projectId?: string;
	/** Extra fields merged into the `Sandbox.create` options. */
	createOptions?: Record<string, unknown>;
};

export type VercelSandboxCreateSession = (request: SandboxProviderRequest) => unknown;
