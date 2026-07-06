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
	/** Options forwarded to every constructed AWS SDK client (e.g. credentials, endpoint). */
	clientOptions?: Record<string, unknown>;
	/** Inject SDK doubles (tests) or real clients to reuse configuration. */
	clients?: AwsSandboxClients;
	/** Alias for `clients` (the single-injection form from the base brief). */
	client?: AwsSandboxClients;

	// --- Fargate (ECS) options ---
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

	// --- CodeBuild options ---
	/** CodeBuild project name (required in codebuild mode). */
	projectName?: string;
};
