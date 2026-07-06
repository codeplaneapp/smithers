import * as _smithers_orchestrator_sandbox_SandboxProvider from '@smithers-orchestrator/sandbox/SandboxProvider';
import { SandboxProviderRequest } from '@smithers-orchestrator/sandbox/SandboxProvider';

/**
 * A Cloud Storage client double: the subset of `@google-cloud/storage`'s
 * `Storage` that the GCS bundle transport calls.
 */
type GcpStorageClient$1 = {
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
type GcpRunJobsClient$1 = {
    jobPath?: (project: string, location: string, job: string) => string;
    locationPath?: (project: string, location: string) => string;
    runJob: (request: unknown) => Promise<[{
        promise: () => Promise<[GcpCloudRunExecution$1]>;
    }]>;
    createJob?: (request: unknown) => Promise<[{
        promise: () => Promise<[unknown]>;
    }]>;
    deleteJob?: (request: unknown) => Promise<[{
        promise: () => Promise<[unknown]>;
    }]>;
};
/**
 * A Cloud Run v2 Execution as returned by `runJob`'s LRO. Only the fields the
 * runner reads to derive an exit code are modeled.
 */
type GcpCloudRunExecution$1 = {
    name?: string;
    succeededCount?: number;
    failedCount?: number;
    conditions?: Array<{
        type?: string;
        state?: string;
        message?: string;
    }>;
};
type GcpSandboxClients$1 = {
    storage?: GcpStorageClient$1;
    run?: GcpRunJobsClient$1;
};
type GcpSandboxProviderOptions$1 = {
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
    /** Compute the remote sandbox id. Default `${runId}-${sandboxId}`. */
    sandboxId?: (request: SandboxProviderRequest) => string;
    /** Inject SDK doubles as a combined `{ storage, run }` object (tests/advanced). */
    client?: GcpSandboxClients$1;
    /** Inject SDK doubles individually. */
    clients?: GcpSandboxClients$1;
    /** Options forwarded to the real SDK client constructors when not injected. */
    clientOptions?: {
        storage?: Record<string, unknown>;
        run?: Record<string, unknown>;
    };
    /** Invoked from the session teardown; used by the contract suite. */
    onDestroy?: () => void | Promise<void>;
};

declare const GCP_SANDBOX_PROVIDER_ID: "gcp-sandbox";

/**
 * Build a Smithers SandboxProvider that executes bundles on Cloud Run Jobs and
 * ships the request/result bundles through a Cloud Storage bucket (no shared
 * filesystem). Auth is Application Default Credentials.
 *
 * @param {import("./GcpSandboxProviderOptions.ts").GcpSandboxProviderOptions} [options]
 * @returns {import("@smithers-orchestrator/sandbox/SandboxProvider").SandboxProvider}
 */
declare function createGcpSandboxProvider(options?: GcpSandboxProviderOptions$1): _smithers_orchestrator_sandbox_SandboxProvider.SandboxProvider;

/**
 * Construct a GCP sandbox provider and register it in the global sandbox
 * provider registry. Returns the unregister function.
 *
 * @param {import("./GcpSandboxProviderOptions.ts").GcpSandboxProviderOptions} [options]
 * @returns {() => void}
 */
declare function registerGcpSandboxProvider(options?: GcpSandboxProviderOptions$1): () => void;

/**
 * In-memory double for the `@google-cloud/storage` + `@google-cloud/run` subset
 * that `createGcpSandboxProvider` calls. It simulates a Cloud Storage bucket
 * (an object Map with save/download/delete) and Cloud Run Jobs (`runJob`
 * returning an LRO whose promise resolves an Execution). The exec path parses
 * the request object from mock GCS, invokes `handler`, writes the returned
 * result JSON to the result object, and resolves a succeeded Execution.
 *
 * This is what makes tests run with ZERO GCP credentials and NO real bucket.
 *
 * @param {(args: { command: string; request: Record<string, unknown>; files: Map<string, string>; env: Record<string, string> }) => import("@smithers-orchestrator/sandbox/SandboxProvider").SandboxProviderResult | Promise<import("@smithers-orchestrator/sandbox/SandboxProvider").SandboxProviderResult>} handler
 * @param {{
 *   faults?: { save?: boolean; download?: boolean; run?: boolean; createJob?: boolean; deleteJob?: boolean };
 *   execution?: { succeededCount?: number; failedCount?: number; conditions?: Array<{ type?: string; state?: string; message?: string }>; name?: string };
 * }} [config]
 */
declare function createMockGcpSandboxEnvironment(handler: (args: {
    command: string;
    request: Record<string, unknown>;
    files: Map<string, string>;
    env: Record<string, string>;
}) => _smithers_orchestrator_sandbox_SandboxProvider.SandboxProviderResult | Promise<_smithers_orchestrator_sandbox_SandboxProvider.SandboxProviderResult>, config?: {
    faults?: {
        save?: boolean;
        download?: boolean;
        run?: boolean;
        createJob?: boolean;
        deleteJob?: boolean;
    };
    execution?: {
        succeededCount?: number;
        failedCount?: number;
        conditions?: Array<{
            type?: string;
            state?: string;
            message?: string;
        }>;
        name?: string;
    };
}): {
    storage: {
        /** @param {string} _name */
        bucket(_name: string): {
            /** @param {string} objectName */
            file(objectName: string): {
                /** @param {string | Uint8Array} content */
                save(content: string | Uint8Array): Promise<void>;
                download(): Promise<Buffer<ArrayBuffer>[]>;
                delete(): Promise<{}[]>;
            };
        };
    };
    run: {
        /**
         * @param {string} project
         * @param {string} location
         * @param {string} job
         */
        jobPath(project: string, location: string, job: string): string;
        /**
         * @param {string} project
         * @param {string} location
         */
        locationPath(project: string, location: string): string;
        /** @param {Record<string, unknown>} request */
        createJob(request: Record<string, unknown>): Promise<{
            promise: () => Promise<[unknown]>;
        }[]>;
        /** @param {Record<string, unknown>} request */
        deleteJob(request: Record<string, unknown>): Promise<{
            promise: () => Promise<[unknown]>;
        }[]>;
        /** @param {{ name: string; overrides?: { containerOverrides?: Array<{ env?: Array<{ name: string; value: string }>; args?: string[] }> } }} request */
        runJob(request: {
            name: string;
            overrides?: {
                containerOverrides?: Array<{
                    env?: Array<{
                        name: string;
                        value: string;
                    }>;
                    args?: string[];
                }>;
            };
        }): Promise<{
            promise: () => Promise<[unknown]>;
        }[]>;
    };
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
 * object under `<prefix>/<runId>/<sandboxId>/<basename(path)>`; writes upload,
 * reads download, and destroy removes the transient objects.
 *
 * @param {{
 *   storage: import("./GcpSandboxProviderOptions.ts").GcpStorageClient;
 *   bucket: string;
 *   prefix: string;
 *   runId: string;
 *   sandboxId: string;
 *   provider?: string;
 * }} options
 */
declare function createGcpSandboxGcsTransport(options: {
    storage: GcpStorageClient$1;
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
    /** @returns {ReadonlyMap<string, string>} */
    readonly mapping: ReadonlyMap<string, string>;
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
     * Delete every transient object this sandbox touched (request, result,
     * egress CA). Best-effort per object so one missing/already-deleted object
     * never blocks the rest.
     *
     * @returns {Promise<void>}
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
 *
 * @param {{
 *   jobsClient: import("./GcpSandboxProviderOptions.ts").GcpRunJobsClient;
 *   projectId: string;
 *   location: string;
 *   jobName: string;
 *   createJob?: boolean;
 *   timeoutSec?: number;
 *   provider?: string;
 * }} options
 */
declare function createGcpCloudRunJobsSandboxRunner(options: {
    jobsClient: GcpRunJobsClient$1;
    projectId: string;
    location: string;
    jobName: string;
    createJob?: boolean;
    timeoutSec?: number;
    provider?: string;
}): {
    readonly remoteId: string;
    readonly createdJob: boolean;
    /**
     * @param {{ command: string; env: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }} exec
     * @returns {Promise<{ exitCode: number; stdout: string; stderr: string }>}
     */
    run(exec: {
        command: string;
        env: Record<string, string>;
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    /**
     * Delete the per-run job when this runner created it. No-op for reused jobs.
     * @returns {Promise<void>}
     */
    deleteJob(): Promise<void>;
};

type GcpSandboxProviderOptions = GcpSandboxProviderOptions$1;
type GcpSandboxClients = GcpSandboxClients$1;
type GcpStorageClient = GcpStorageClient$1;
type GcpRunJobsClient = GcpRunJobsClient$1;
type GcpCloudRunExecution = GcpCloudRunExecution$1;

export { GCP_SANDBOX_PROVIDER_ID, type GcpCloudRunExecution, type GcpRunJobsClient, type GcpSandboxClients, type GcpSandboxProviderOptions, type GcpStorageClient, createGcpCloudRunJobsSandboxRunner, createGcpSandboxGcsTransport, createGcpSandboxProvider, createMockGcpSandboxEnvironment, registerGcpSandboxProvider };
