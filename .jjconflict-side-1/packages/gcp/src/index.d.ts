import type { SandboxProvider, SandboxProviderRequest, SandboxProviderResult } from "@smithers-orchestrator/sandbox";

export const GCP_SANDBOX_PROVIDER_ID: "gcp-sandbox";

/**
 * A Cloud Storage client double: the subset of `@google-cloud/storage`'s
 * `Storage` that the GCS bundle transport calls.
 */
export type GcpStorageClient = {
	bucket: (name: string) => {
		file: (objectName: string) => {
			save: (content: string | Uint8Array) => Promise<unknown>;
			download: () => Promise<[Buffer | Uint8Array | string]>;
			delete: (options?: unknown) => Promise<unknown>;
		};
	};
};

/**
 * A Cloud Run v2 Execution as returned by `runJob`'s LRO. Only the fields the
 * runner reads to derive an exit code are modeled.
 */
export type GcpCloudRunExecution = {
	name?: string;
	succeededCount?: number;
	failedCount?: number;
	conditions?: Array<{
		type?: string;
		state?: string;
		message?: string;
	}>;
};

/**
 * A Cloud Run Jobs client double: the subset of `@google-cloud/run` v2
 * `JobsClient` that the Cloud Run runner calls. `runJob`/`createJob`/`deleteJob`
 * return `[operation]` LRO tuples whose `operation.promise()` resolves the
 * long-running result.
 */
export type GcpRunJobsClient = {
	jobPath?: (project: string, location: string, job: string) => string;
	locationPath?: (project: string, location: string) => string;
	runJob: (request: unknown) => Promise<[{ promise: () => Promise<[GcpCloudRunExecution]>; cancel?: () => Promise<unknown>; metadata?: { name?: string } }]>;
	createJob?: (request: unknown) => Promise<[{ promise: () => Promise<[unknown]> }]>;
	deleteJob?: (request: unknown) => Promise<[{ promise: () => Promise<[unknown]> }]>;
	/** Best-effort abort path invoked when a run is cancelled mid-execution. */
	cancelExecution?: (request: unknown) => Promise<[{ promise?: () => Promise<[unknown]> }]>;
	deleteExecution?: (request: unknown) => Promise<[{ promise?: () => Promise<[unknown]> }]>;
};

export type GcpSandboxClients = {
	storage?: GcpStorageClient;
	run?: GcpRunJobsClient;
};

export type GcpSandboxProviderOptions = {
	/** GCP project id. Required. Falls back to `GOOGLE_CLOUD_PROJECT`. */
	projectId?: string;
	/** Cloud Run region, e.g. `us-central1`. Required. */
	location?: string;
	/** Pre-existing Cloud Storage bucket used as the bundle transport. Required. */
	bucket?: string;
	/** Cloud Run Job name to run. Required. Created per-run when `createJob` is set. */
	jobName?: string;
	/** Object-name prefix inside the bucket. Default `smithers/sandbox`. */
	prefix?: string;
	/** Provider id override. Default `gcp-sandbox`. */
	id?: string;
	/** In-container entry command. Default `node /workspace/run-smithers-sandbox.js`. */
	command?: string;
	/** In-container working directory. Default `/workspace`. */
	workdir?: string;
	/** Extra environment forwarded into the container. Never carries local creds. */
	env?: Record<string, string>;
	/** `destroy` (default) tears down transient objects + per-run job; `keep` leaves them. */
	cleanup?: "destroy" | "keep";
	/** Cloud Run execution timeout in seconds. Default derived from the request tool timeout. */
	timeoutSec?: number;
	/** Create a fresh per-run Cloud Run Job (LRO) instead of reusing `jobName`. */
	createJob?: boolean;
	/** Container image for the per-run job created when `createJob` is set. */
	image?: string;
	/** Compute the remote sandbox id. Default `${runId}-${sandboxId}`. */
	sandboxId?: (request: SandboxProviderRequest) => string;
	/** Inject SDK doubles as a combined `{ storage, run }` object (tests/advanced). */
	client?: GcpSandboxClients;
	/** Inject SDK doubles individually. */
	clients?: GcpSandboxClients;
	/** Options forwarded to the real SDK client constructors when not injected. */
	clientOptions?: {
		storage?: Record<string, unknown>;
		run?: Record<string, unknown>;
	};
	/** Invoked from the session teardown; used by the contract suite. */
	onDestroy?: () => void | Promise<void>;
};

/**
 * Build a Smithers SandboxProvider that executes bundles on Cloud Run Jobs and
 * ships the request/result bundles through a Cloud Storage bucket (no shared
 * filesystem). Auth is Application Default Credentials.
 */
export function createGcpSandboxProvider(options?: GcpSandboxProviderOptions): SandboxProvider;

/**
 * Construct a GCP sandbox provider and register it in the global sandbox
 * provider registry. Returns the unregister function.
 */
export function registerGcpSandboxProvider(options?: GcpSandboxProviderOptions): () => void;

/**
 * In-memory double for the `@google-cloud/storage` + `@google-cloud/run` subset
 * that `createGcpSandboxProvider` calls. It simulates a Cloud Storage bucket
 * (an object Map with save/download/delete) and Cloud Run Jobs (`runJob`
 * returning an LRO whose promise resolves an Execution). The exec path parses
 * the request object from mock GCS, invokes `handler`, writes the returned
 * result JSON to the result object, and resolves a succeeded Execution.
 *
 * This is what makes tests run with ZERO GCP credentials and NO real bucket.
 */
export function createMockGcpSandboxEnvironment(
	handler: (args: {
		command: string;
		request: Record<string, unknown>;
		files: Map<string, string>;
		env: Record<string, string>;
	}) => SandboxProviderResult | Promise<SandboxProviderResult>,
	config?: {
		faults?: { save?: boolean; download?: boolean; run?: boolean; createJob?: boolean; deleteJob?: boolean };
		execution?: {
			succeededCount?: number;
			failedCount?: number;
			conditions?: Array<{ type?: string; state?: string; message?: string }>;
			name?: string;
		};
	},
): {
	storage: GcpStorageClient;
	run: GcpRunJobsClient;
	objects: Map<string, string>;
	runRequests: Record<string, unknown>[];
	createdJobs: Record<string, unknown>[];
	deletedJobs: Record<string, unknown>[];
	readonly destroyed: boolean;
	/** Simulate the whole environment going away (exec after destroy rejects). */
	destroy(): void;
};

/**
 * Build the Cloud Storage bundle transport a GCP sandbox session uses instead of
 * a shared filesystem. Every workdir-relative path maps to a deterministic
 * object under `<prefix>/<runId>/<sandboxId>/<encoded full workdir-relative path>`; writes upload,
 * reads download, and destroy removes the transient objects.
 */
export function createGcpSandboxGcsTransport(options: {
	storage: GcpStorageClient;
	bucket: string;
	prefix: string;
	runId: string;
	sandboxId: string;
	provider?: string;
}): {
	bucket: string;
	prefix: string;
	keyPrefix: string;
	objectNameFor: (path: string) => string;
	readonly mapping: ReadonlyMap<string, string>;
	writeFile(path: string, content: string): Promise<void>;
	readFile(path: string): Promise<string>;
	/**
	 * Delete every transient object this sandbox touched (request, result,
	 * egress CA). Best-effort per object so one missing/already-deleted object
	 * never blocks the rest.
	 */
	deleteAll(): Promise<void>;
	provider: string;
};

/**
 * Build the Cloud Run Jobs runner a GCP sandbox session uses to execute the
 * in-container entry command. It optionally creates a per-run job (LRO), then
 * `runJob` with container overrides that carry the command + env, awaits the
 * execution LRO, and maps the execution outcome to `{ exitCode, stdout, stderr }`.
 * The container round-trips its result bundle through Cloud Storage, so stdout
 * is always empty here — the kit reads the result object via the transport.
 */
export function createGcpCloudRunJobsSandboxRunner(options: {
	jobsClient: GcpRunJobsClient;
	projectId: string;
	location: string;
	jobName: string;
	createJob?: boolean;
	timeoutSec?: number;
	provider?: string;
}): {
	readonly remoteId: string;
	readonly createdJob: boolean;
	run(exec: {
		command: string;
		env: Record<string, string>;
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** Delete the per-run job when this runner created it. No-op for reused jobs. */
	deleteJob(): Promise<void>;
};
