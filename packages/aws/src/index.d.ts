import type { SandboxProvider, SandboxProviderResult } from "@smithers-orchestrator/sandbox";

export const AWS_SANDBOX_PROVIDER_ID: "aws-sandbox";

/**
 * Method-based double for the `@aws-sdk/client-ecs` surface used by the ECS
 * runner. A real `ECSClient` (which exposes only `.send()`) is wrapped into
 * this shape internally; tests inject a double implementing these methods
 * directly so the real SDK is never imported.
 */
export type AwsEcsClientLike = {
	runTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	describeTasks: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	stopTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	send?: (command: unknown) => Promise<unknown>;
};

/** Method-based double for the `@aws-sdk/client-codebuild` surface. */
export type AwsCodeBuildClientLike = {
	startBuild: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	batchGetBuilds: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	stopBuild: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	send?: (command: unknown) => Promise<unknown>;
};

/** Method-based double for the `@aws-sdk/client-s3` surface. */
export type AwsS3ClientLike = {
	putObject: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	getObject: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	deleteObjects: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	send?: (command: unknown) => Promise<unknown>;
};

/** Method-based double for the `@aws-sdk/client-cloudwatch-logs` surface. */
export type AwsLogsClientLike = {
	getLogEvents: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	send?: (command: unknown) => Promise<unknown>;
};

/**
 * Bag of injectable SDK doubles. Tests pass a fully-populated bag (from
 * `createMockAwsSandboxEnvironment`); real users usually pass nothing and let
 * the factory construct clients from `clientOptions` + the AWS credential
 * chain, or inject a single real client to reuse an existing configuration.
 */
export type AwsSandboxClients = {
	s3?: AwsS3ClientLike;
	ecs?: AwsEcsClientLike;
	codebuild?: AwsCodeBuildClientLike;
	logs?: AwsLogsClientLike;
};

export type AwsSandboxProviderOptions = {
	/** Override the provider id (defaults to `aws-sandbox`). */
	id?: string;
	/** Remote execution backend. Defaults to `"fargate"`. */
	mode?: "fargate" | "codebuild";
	/** AWS region for every client. Required. */
	region?: string;
	/** Pre-existing S3 bucket used as the request/result bundle transport. Required. */
	bucket?: string;
	/** In-sandbox entry command (defaults to the provider-kit default). */
	command?: string;
	/** Remote working directory (defaults to `/workspace`). */
	workdir?: string;
	/** Extra environment handed to the remote command. Never carries local creds. */
	env?: Record<string, string>;
	/** Cleanup behavior after each run. Defaults to `"destroy"`. */
	cleanup?: "destroy" | "keep";
	/** Capture CloudWatch logs into the exec stdout (truncated to maxOutputBytes). */
	captureLogs?: boolean;
	/** CloudWatch log group to read when `captureLogs` is set. */
	logGroupName?: string;
	/** awslogs stream prefix used to locate the task's CloudWatch stream (defaults to the container name). */
	awslogsStreamPrefix?: string;
	/** Options forwarded to every constructed AWS SDK client (e.g. credentials, endpoint). */
	clientOptions?: Record<string, unknown>;
	/** Inject SDK doubles (tests) or real clients to reuse configuration. */
	clients?: AwsSandboxClients;
	/** Alias for `clients` (the single-injection form from the base brief). */
	client?: AwsSandboxClients;
	/** ECS cluster ARN or name (required in fargate mode). */
	cluster?: string;
	/** ECS task definition ARN or family (required in fargate mode). */
	taskDefinition?: string;
	/** VPC subnet ids for the awsvpc network configuration (required, non-empty). */
	subnets?: string[];
	/** Optional security group ids. */
	securityGroups?: string[];
	/** `"ENABLED"` or `"DISABLED"` public IP assignment. Defaults to `"DISABLED"`. */
	assignPublicIp?: "ENABLED" | "DISABLED";
	/** Container name inside the task definition to override (required in fargate mode). */
	containerName?: string;
	/** CodeBuild project name (required in codebuild mode). */
	projectName?: string;
};

/**
 * Build a Smithers SandboxProvider backed by AWS. Because AWS has no shared
 * filesystem between the orchestrator and the remote task, the request/result
 * bundle is transported through S3: `writeFile`/`readFile` map a workdir path to
 * `s3://<bucket>/smithers/sandbox/<runId>/<sandboxId>/<encoded full workdir-relative path>`, and the
 * remote container round-trips the same keys via the injected
 * `SMITHERS_SANDBOX_S3_*` env vars.
 */
export function createAwsSandboxProvider(options?: AwsSandboxProviderOptions): SandboxProvider;

/**
 * Construct an AWS sandbox provider and register it with the sandbox runtime.
 * Returns the unregister function.
 */
export function registerAwsSandboxProvider(options?: AwsSandboxProviderOptions): () => void;

/**
 * In-memory AWS SDK doubles for the sandbox provider. Implements exactly the
 * subset each mode calls:
 *
 * - **S3** (`putObject`/`getObject`/`deleteObjects`) — a shared object store
 *   used as the bundle transport by both modes.
 * - **ECS** (`runTask`/`describeTasks`/`stopTask`) — fargate mode. `runTask`
 *   parses the request object from the store, calls `handler`, writes the
 *   result back to the store, and records a task that `describeTasks` reports as
 *   `STOPPED` with the configured exit code.
 * - **CodeBuild** (`startBuild`/`batchGetBuilds`/`stopBuild`) — codebuild mode.
 *   Same handler round-trip; `batchGetBuilds` reports the configured status.
 * - **CloudWatch Logs** (`getLogEvents`) — returns the configured `logEvents`.
 *
 * Fault injection (`faults.create|exec|upload|download`) reproduces launch, run,
 * upload, and download failures. Everything is deterministic and requires no AWS
 * credentials.
 */
export function createMockAwsSandboxEnvironment(
	handler: (args: {
		command: string;
		request: Record<string, unknown>;
		files: Map<string, string>;
		env: Record<string, string>;
	}) => SandboxProviderResult | Promise<SandboxProviderResult>,
	mockOptions?: {
		exitCode?: number;
		stoppedReason?: string;
		buildStatus?: string;
		writeResult?: boolean;
		logEvents?: string[];
		faultMessage?: string;
		faults?: { create?: boolean; exec?: boolean; upload?: boolean; download?: boolean };
	},
): AwsSandboxClients & {
	store: Map<string, string>;
	readonly command: string;
	readonly env: Record<string, string>;
	readonly stoppedTasks: string[];
	readonly stoppedBuilds: string[];
	readonly destroyed: boolean;
	setExitCode(value: number): void;
	setStoppedReason(value: string | undefined): void;
	setBuildStatus(value: string): void;
	setWriteResult(value: boolean): void;
	setFault(name: "create" | "exec" | "upload" | "download", on?: boolean): void;
	destroy(): void;
};

/**
 * Build the S3-backed file transport for one sandbox session. Every workdir
 * path maps to a single flat object key
 * `s3://<bucket>/smithers/sandbox/<runId>/<sandboxId>/<encoded full workdir-relative path>`. The
 * container round-trips the request/result JSON through the same keys.
 */
export function createAwsSandboxS3Transport(config: {
	s3: {
		putObject: (input: Record<string, unknown>) => Promise<unknown>;
		getObject: (input: Record<string, unknown>) => Promise<unknown>;
		deleteObjects: (input: Record<string, unknown>) => Promise<unknown>;
	};
	bucket: string;
	prefix: string;
	workdir?: string;
	secrets?: string[];
}): {
	bucket: string;
	prefix: string;
	keyForPath: (path: string) => string;
	writtenKeys(): string[];
	writeFile(path: string, content: string): Promise<void>;
	readFile(path: string): Promise<string>;
	/** Delete every transient object this session wrote (request/result/CA). */
	deleteAll(): Promise<void>;
};

/**
 * Build the Fargate (ECS RunTask) remote runner. It launches one task per exec,
 * polls DescribeTasks until the task stops, and returns the container's numeric
 * exit code. The actual request/result payload round-trips through S3; the task
 * command is `sh -c "<command>"`.
 */
export function createAwsEcsSandboxRunner(options: {
	client?: unknown;
	clientOptions?: Record<string, unknown>;
	cluster?: string;
	taskDefinition?: string;
	subnets?: string[];
	securityGroups?: string[];
	assignPublicIp?: "ENABLED" | "DISABLED";
	containerName?: string;
	captureLogs?: boolean;
	logs?: unknown;
	logGroupName?: string;
	awslogsStreamPrefix?: string;
	maxOutputBytes?: number;
	secrets?: string[];
}): Promise<{
	readonly remoteId: string | undefined;
	run(
		command: string,
		execOpts: { env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	stop: (signal?: AbortSignal) => Promise<void>;
}>;

/**
 * Build the CodeBuild remote runner. It starts one build per exec with an S3
 * source/artifacts override and a generated buildspec that runs the command,
 * then polls BatchGetBuilds. CodeBuild reports a status, not a numeric exit, so
 * `SUCCEEDED` maps to exit 0 and anything else to exit 1.
 */
export function createAwsCodeBuildSandboxRunner(options: {
	client?: unknown;
	clientOptions?: Record<string, unknown>;
	projectName?: string;
	bucket?: string;
	prefix?: string;
	captureLogs?: boolean;
	logs?: unknown;
	maxOutputBytes?: number;
	secrets?: string[];
}): Promise<{
	readonly remoteId: string | undefined;
	run(
		command: string,
		execOpts: { env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	stop: (signal?: AbortSignal) => Promise<void>;
}>;
