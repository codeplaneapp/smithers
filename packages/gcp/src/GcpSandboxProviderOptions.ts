import type { SandboxProviderRequest } from "@smithers-orchestrator/sandbox";

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

/**
 * A Cloud Run v2 Execution as returned by `runJob`'s LRO. Only the fields the
 * runner reads to derive an exit code are modeled.
 */
export type GcpCloudRunExecution = {
	name?: string;
	succeededCount?: number;
	failedCount?: number;
	conditions?: Array<{ type?: string; state?: string; message?: string }>;
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
	clientOptions?: { storage?: Record<string, unknown>; run?: Record<string, unknown> };
	/**
	 * Injectable importer for `@google-cloud/storage`; tests only. Production
	 * defaults to the real dynamic import.
	 */
	importStorageSdk?: () => Promise<unknown>;
	/**
	 * Injectable importer for `@google-cloud/run`; tests only. Production defaults
	 * to the real dynamic import.
	 */
	importRunSdk?: () => Promise<unknown>;
	/** Invoked from the session teardown; used by the contract suite. */
	onDestroy?: () => void | Promise<void>;
};
