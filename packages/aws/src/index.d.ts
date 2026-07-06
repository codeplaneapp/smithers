import * as _smithers_orchestrator_sandbox from '@smithers-orchestrator/sandbox';

declare const AWS_SANDBOX_PROVIDER_ID: "aws-sandbox";

/**
 * Method-based double for the `@aws-sdk/client-ecs` surface used by the ECS
 * runner. A real `ECSClient` (which exposes only `.send()`) is wrapped into
 * this shape internally; tests inject a double implementing these methods
 * directly so the real SDK is never imported.
 */
type AwsEcsClientLike = {
    runTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    describeTasks: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    stopTask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    send?: (command: unknown) => Promise<unknown>;
};
/** Method-based double for the `@aws-sdk/client-codebuild` surface. */
type AwsCodeBuildClientLike = {
    startBuild: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    batchGetBuilds: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    stopBuild: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    send?: (command: unknown) => Promise<unknown>;
};
/** Method-based double for the `@aws-sdk/client-s3` surface. */
type AwsS3ClientLike = {
    putObject: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    getObject: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    deleteObjects: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    send?: (command: unknown) => Promise<unknown>;
};
/** Method-based double for the `@aws-sdk/client-cloudwatch-logs` surface. */
type AwsLogsClientLike = {
    getLogEvents: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    send?: (command: unknown) => Promise<unknown>;
};
/**
 * Bag of injectable SDK doubles. Tests pass a fully-populated bag (from
 * `createMockAwsSandboxEnvironment`); real users usually pass nothing and let
 * the factory construct clients from `clientOptions` + the AWS credential
 * chain, or inject a single real client to reuse an existing configuration.
 */
type AwsSandboxClients = {
    s3?: AwsS3ClientLike;
    ecs?: AwsEcsClientLike;
    codebuild?: AwsCodeBuildClientLike;
    logs?: AwsLogsClientLike;
};
type AwsSandboxProviderOptions = {
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
 * `s3://<bucket>/smithers/sandbox/<runId>/<sandboxId>/<basename(path)>`, and the
 * remote container round-trips the same keys via the injected
 * `SMITHERS_SANDBOX_S3_*` env vars.
 *
 * @param {import("./AwsSandboxProviderOptions.ts").AwsSandboxProviderOptions} [options]
 * @returns {import("@smithers-orchestrator/sandbox").SandboxProvider}
 */
declare function createAwsSandboxProvider(options?: AwsSandboxProviderOptions): _smithers_orchestrator_sandbox.SandboxProvider;

/**
 * Construct an AWS sandbox provider and register it with the sandbox runtime.
 *
 * @param {import("./AwsSandboxProviderOptions.ts").AwsSandboxProviderOptions} [options]
 * @returns {() => void} unregister function
 */
declare function registerAwsSandboxProvider(options?: AwsSandboxProviderOptions): () => void;

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
 *
 * @param {(args: { command: string; request: Record<string, unknown>; files: Map<string, string>; env: Record<string, string> }) => import("@smithers-orchestrator/sandbox").SandboxProviderResult | Promise<import("@smithers-orchestrator/sandbox").SandboxProviderResult>} handler
 * @param {{
 *   exitCode?: number;
 *   stoppedReason?: string;
 *   buildStatus?: string;
 *   writeResult?: boolean;
 *   logEvents?: string[];
 *   faultMessage?: string;
 *   faults?: { create?: boolean; exec?: boolean; upload?: boolean; download?: boolean };
 * }} [mockOptions]
 */
declare function createMockAwsSandboxEnvironment(handler: (args: {
    command: string;
    request: Record<string, unknown>;
    files: Map<string, string>;
    env: Record<string, string>;
}) => _smithers_orchestrator_sandbox.SandboxProviderResult | Promise<_smithers_orchestrator_sandbox.SandboxProviderResult>, mockOptions?: {
    exitCode?: number;
    stoppedReason?: string;
    buildStatus?: string;
    writeResult?: boolean;
    logEvents?: string[];
    faultMessage?: string;
    faults?: {
        create?: boolean;
        exec?: boolean;
        upload?: boolean;
        download?: boolean;
    };
}): {
    s3: {
        /** @param {Record<string, unknown>} input */
        putObject(input: Record<string, unknown>): Promise<{}>;
        /** @param {Record<string, unknown>} input */
        getObject(input: Record<string, unknown>): Promise<{
            Body: {
                transformToString: () => Promise<string>;
            };
        }>;
        /** @param {Record<string, any>} input */
        deleteObjects(input: Record<string, any>): Promise<{
            Deleted: any;
        }>;
    };
    ecs: {
        /** @param {Record<string, any>} input */
        runTask(input: Record<string, any>): Promise<{
            tasks: {
                taskArn: string;
                lastStatus: string;
            }[];
            failures: never[];
        }>;
        /** @param {Record<string, any>} input */
        describeTasks(input: Record<string, any>): Promise<{
            tasks: never[];
            failures: {
                arn: string;
                reason: string;
            }[];
        } | {
            tasks: {
                taskArn: string;
                lastStatus: string;
                stoppedReason: string | undefined;
                containers: {
                    name: string | undefined;
                    exitCode: number;
                }[];
            }[];
            failures?: undefined;
        }>;
        /** @param {Record<string, any>} input */
        stopTask(input: Record<string, any>): Promise<{
            task: {
                taskArn: any;
            };
        }>;
    };
    codebuild: {
        /** @param {Record<string, any>} input */
        startBuild(input: Record<string, any>): Promise<{
            build: {
                id: string;
                buildStatus: string;
            };
        }>;
        /** @param {Record<string, any>} input */
        batchGetBuilds(input: Record<string, any>): Promise<{
            builds: {
                id: string;
                buildStatus: string;
                logs: {
                    groupName: string;
                    streamName: string;
                };
            }[];
        }>;
        /** @param {Record<string, any>} input */
        stopBuild(input: Record<string, any>): Promise<{
            build: {
                id: any;
                buildStatus: string;
            };
        }>;
    };
    logs: {
        getLogEvents(): Promise<{
            events: {
                message: string;
            }[];
        }>;
    };
    store: Map<string, string>;
    readonly command: string;
    readonly env: Record<string, string>;
    readonly stoppedTasks: string[];
    readonly stoppedBuilds: string[];
    readonly destroyed: boolean;
    /** @param {number} value */
    setExitCode(value: number): void;
    /** @param {string | undefined} value */
    setStoppedReason(value: string | undefined): void;
    /** @param {string} value */
    setBuildStatus(value: string): void;
    /** @param {boolean} value */
    setWriteResult(value: boolean): void;
    /**
     * @param {"create" | "exec" | "upload" | "download"} name
     * @param {boolean} [on]
     */
    setFault(name: "create" | "exec" | "upload" | "download", on?: boolean): void;
    destroy(): void;
};

/**
 * Build the S3-backed file transport for one sandbox session. Every workdir
 * path maps to a single flat object key
 * `s3://<bucket>/smithers/sandbox/<runId>/<sandboxId>/<basename(path)>`. The
 * container round-trips the request/result JSON through the same keys.
 *
 * @param {{
 *   s3: { putObject: (input: Record<string, unknown>) => Promise<any>; getObject: (input: Record<string, unknown>) => Promise<any>; deleteObjects: (input: Record<string, unknown>) => Promise<any> };
 *   bucket: string;
 *   prefix: string;
 *   secrets?: string[];
 * }} config
 */
declare function createAwsSandboxS3Transport(config: {
    s3: {
        putObject: (input: Record<string, unknown>) => Promise<any>;
        getObject: (input: Record<string, unknown>) => Promise<any>;
        deleteObjects: (input: Record<string, unknown>) => Promise<any>;
    };
    bucket: string;
    prefix: string;
    secrets?: string[];
}): {
    bucket: string;
    prefix: string;
    keyForPath: (path: string) => string;
    /** @returns {string[]} */
    writtenKeys(): string[];
    /**
     * @param {string} path
     * @param {string} content
     * @returns {Promise<void>}
     */
    writeFile(path: string, content: string): Promise<void>;
    /**
     * @param {string} path
     * @returns {Promise<string>}
     */
    readFile(path: string): Promise<string>;
    /**
     * Delete every transient object this session wrote (request/result/CA).
     * @returns {Promise<void>}
     */
    deleteAll(): Promise<void>;
};

/**
 * Build the Fargate (ECS RunTask) remote runner. It launches one task per exec,
 * polls DescribeTasks until the task stops, and returns the container's numeric
 * exit code. The actual request/result payload round-trips through S3; the task
 * command is `sh -c "<command>"`.
 *
 * @param {{
 *   client?: unknown;
 *   clientOptions?: Record<string, unknown>;
 *   cluster?: string;
 *   taskDefinition?: string;
 *   subnets?: string[];
 *   securityGroups?: string[];
 *   assignPublicIp?: "ENABLED" | "DISABLED";
 *   containerName?: string;
 *   region?: string;
 *   captureLogs?: boolean;
 *   logs?: unknown;
 *   logGroupName?: string;
 *   maxOutputBytes?: number;
 *   secrets?: string[];
 * }} options
 */
declare function createAwsEcsSandboxRunner(options: {
    client?: unknown;
    clientOptions?: Record<string, unknown>;
    cluster?: string;
    taskDefinition?: string;
    subnets?: string[];
    securityGroups?: string[];
    assignPublicIp?: "ENABLED" | "DISABLED";
    containerName?: string;
    region?: string;
    captureLogs?: boolean;
    logs?: unknown;
    logGroupName?: string;
    maxOutputBytes?: number;
    secrets?: string[];
}): Promise<{
    readonly remoteId: string | undefined;
    /**
     * @param {string} command
     * @param {{ env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }} execOpts
     * @returns {Promise<{ exitCode: number; stdout: string; stderr: string }>}
     */
    run(command: string, execOpts: {
        env: Record<string, string>;
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    stop: () => Promise<void>;
}>;

/**
 * Build the CodeBuild remote runner. It starts one build per exec with an S3
 * source/artifacts override and a generated buildspec that runs the command,
 * then polls BatchGetBuilds. CodeBuild reports a status, not a numeric exit, so
 * `SUCCEEDED` maps to exit 0 and anything else to exit 1.
 *
 * @param {{
 *   client?: unknown;
 *   clientOptions?: Record<string, unknown>;
 *   projectName?: string;
 *   bucket?: string;
 *   prefix?: string;
 *   captureLogs?: boolean;
 *   logs?: unknown;
 *   maxOutputBytes?: number;
 *   secrets?: string[];
 * }} options
 */
declare function createAwsCodeBuildSandboxRunner(options: {
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
    /**
     * @param {string} command
     * @param {{ env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }} execOpts
     * @returns {Promise<{ exitCode: number; stdout: string; stderr: string }>}
     */
    run(command: string, execOpts: {
        env: Record<string, string>;
        timeoutMs: number;
        signal?: AbortSignal;
    }): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    stop: () => Promise<void>;
}>;

export { AWS_SANDBOX_PROVIDER_ID, createAwsCodeBuildSandboxRunner, createAwsEcsSandboxRunner, createAwsSandboxProvider, createAwsSandboxS3Transport, createMockAwsSandboxEnvironment, registerAwsSandboxProvider };
