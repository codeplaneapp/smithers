/**
 * Options for `createDaytonaSandboxProvider`.
 *
 * Everything except the kit knobs (`id`/`command`/`workdir`/`env`/`cleanup`) is
 * forwarded to `daytona.create()`. The Daytona client is constructed lazily
 * from `clientOptions` + the documented env vars unless `client` is injected.
 */
export type DaytonaSandboxProviderOptions = {
	/** Provider id. Defaults to `daytona-sandbox`. */
	id?: string;
	/** Entry command run inside the sandbox. Defaults to the kit default. */
	command?: string;
	/** Remote working directory the request/result files live under. */
	workdir?: string;
	/** Extra env injected into the exec (never local credentials). */
	env?: Record<string, string>;
	/** Whether to delete the sandbox after the run. Defaults to `destroy`. */
	cleanup?: "destroy" | "keep";

	/** Inject a Daytona SDK client double (tests / advanced wiring). */
	client?: DaytonaClientLike;
	/** Injectable SDK importer (tests only) to exercise the not-installed path. */
	importSdk?: () => Promise<unknown>;
	/** Options forwarded to `new Daytona(...)` when no `client` is injected. */
	clientOptions?: DaytonaClientOptions;
	/** Daytona API key. Falls back to `DAYTONA_API_KEY`. */
	apiKey?: string;
	/** Daytona API url. Falls back to `DAYTONA_API_URL`. */
	apiUrl?: string;
	/** Daytona target region. Falls back to `DAYTONA_TARGET`. */
	target?: string;

	/** Base image for the created sandbox. */
	image?: string;
	/** Snapshot to boot the sandbox from (mutually exclusive with `image`). */
	snapshot?: string;
	/** Labels attached to the created sandbox. */
	labels?: Record<string, string>;
	/** Compute resources for the sandbox (cpu/memory/disk). */
	resources?: DaytonaResources;
	/** Delete the sandbox when the client disconnects. Defaults to `true`. */
	ephemeral?: boolean;
	/** Minutes of idle time before Daytona auto-stops the sandbox. Defaults to `15`. */
	autoStopInterval?: number;
};

export type DaytonaClientOptions = {
	apiKey?: string;
	apiUrl?: string;
	target?: string;
};

export type DaytonaResources = {
	cpu?: number;
	memory?: number;
	disk?: number;
};

export type DaytonaCreateOptions = {
	image?: string;
	snapshot?: string;
	envVars?: Record<string, string>;
	labels?: Record<string, string>;
	ephemeral?: boolean;
	autoStopInterval?: number;
	resources?: DaytonaResources;
};

export type DaytonaSandboxLike = {
	id: string;
	fs: {
		uploadFile: (content: Uint8Array | Buffer, path: string) => Promise<unknown>;
		downloadFile: (path: string) => Promise<Uint8Array | Buffer | string>;
	};
	process: {
		executeCommand: (
			command: string,
			cwd?: string,
			env?: Record<string, string>,
			timeoutSecs?: number,
		) => Promise<{ exitCode?: number; result?: string }>;
	};
	waitUntilStarted?: () => Promise<unknown>;
	state?: string;
};

export type DaytonaClientLike = {
	create: (options?: DaytonaCreateOptions) => Promise<DaytonaSandboxLike>;
	delete: (sandbox: DaytonaSandboxLike) => Promise<unknown>;
};
