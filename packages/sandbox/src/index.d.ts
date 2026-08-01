import { lstat } from 'node:fs/promises';
import * as _smithers_orchestrator_observability_SmithersEvent from '@smithers-orchestrator/observability/SmithersEvent';
import { SmithersDb } from '@smithers-orchestrator/db/adapter';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Layer } from 'effect';

type SandboxRuntime$1 = "bubblewrap" | "docker" | "codeplane" | "cloudflare";

type SandboxWorkflow = {
    db?: unknown;
    build: (ctx: unknown) => unknown;
    opts?: Record<string, unknown>;
    schemaRegistry?: unknown;
    zodToKeyName?: unknown;
};
type SandboxChildWorkflowDefinition = SandboxWorkflow | (() => SandboxWorkflow | unknown);
type ExecuteSandboxChildWorkflowOptions = {
    workflow: SandboxChildWorkflowDefinition;
    input?: unknown;
    runId?: string;
    parentRunId?: string;
    rootDir?: string;
    allowNetwork?: boolean;
    maxOutputBytes?: number;
    toolTimeoutMs?: number;
    workflowPath?: string;
    signal?: AbortSignal;
};
type ExecuteSandboxChildWorkflow = (parentWorkflow: SandboxWorkflow | undefined, options: ExecuteSandboxChildWorkflowOptions) => Promise<{
    runId: string;
    status: string;
    output: unknown;
}>;
type ExecuteSandboxOptions$1 = {
    parentWorkflow?: SandboxWorkflow;
    sandboxId: string;
    provider?: SandboxProvider$1 | string;
    runtime?: SandboxRuntime$1;
    workflow: SandboxChildWorkflowDefinition;
    executeChildWorkflow: ExecuteSandboxChildWorkflow;
    applyDiffBundle?: (bundle: SandboxDiffBundleLike, targetDir: string) => Promise<void>;
    input?: unknown;
    rootDir: string;
    allowNetwork: boolean;
    maxOutputBytes: number;
    toolTimeoutMs: number;
    reviewDiffs?: boolean;
    autoAcceptDiffs?: boolean;
    allowNested?: boolean;
    config?: Record<string, unknown>;
};

type SandboxEgressConfig = {
    env?: Record<string, string>;
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string | string[];
    caCertPem?: string;
    caCertPath?: string;
    secretBindings?: Record<string, string>;
};

type SandboxBundleStatus = "finished" | "failed" | "cancelled";
type SandboxDiffBundleLike = {
    seq: number;
    baseRef: string;
    patches: Array<{
        path: string;
        operation: "add" | "modify" | "delete";
        diff: string;
        binaryContent?: string;
    }>;
};
type SandboxProviderRequest$1 = {
    runId: string;
    sandboxId: string;
    input?: unknown;
    rootDir: string;
    requestBundlePath: string;
    resultBundlePath: string;
    workflow: SandboxChildWorkflowDefinition;
    parentWorkflow?: SandboxWorkflow;
    executeChildWorkflow: ExecuteSandboxChildWorkflow;
    allowNetwork: boolean;
    maxOutputBytes: number;
    toolTimeoutMs: number;
    egress?: SandboxEgressConfig;
    config: Record<string, unknown>;
    signal?: AbortSignal;
    heartbeat: (data?: unknown) => void;
};
type SandboxProviderResult$1 = {
    bundlePath: string;
    remoteRunId?: string;
    workspaceId?: string;
    containerId?: string;
} | {
    status: SandboxBundleStatus;
    output?: unknown;
    outputs?: unknown;
    runId?: string;
    remoteRunId?: string;
    workspaceId?: string;
    containerId?: string;
    diffBundle?: SandboxDiffBundleLike;
    patches?: Array<{
        path: string;
        content: string;
    }>;
    artifacts?: Array<{
        path: string;
        content: string;
    }>;
    streamLogPath?: string | null;
};
type SandboxProvider$1 = {
    id: string;
    run: (request: SandboxProviderRequest$1) => Promise<SandboxProviderResult$1> | SandboxProviderResult$1;
    cleanup?: (request: SandboxProviderRequest$1) => Promise<void> | void;
};

type SandboxBundleManifest$1 = {
    outputs: unknown;
    status: "finished" | "failed" | "cancelled";
    runId?: string;
    patches?: string[];
    diffBundle?: SandboxDiffBundleLike;
};

type ValidatedSandboxBundle$1 = {
    manifest: SandboxBundleManifest$1;
    bundleSizeBytes: number;
    patchFiles: string[];
    logsPath: string | null;
    bundlePath: string;
};

/**
 * @param {string} bundlePath
 * @param {{ lstatLogs?: typeof lstat }} [fsOverrides] Injection seam for the
 *   final logs lstat, so tests can exercise the TOCTOU re-check that guards a
 *   symlink appearing between the bundle walk and the logs stat.
 * @returns {Promise<ValidatedSandboxBundle>}
 */
declare function validateSandboxBundle(bundlePath: string, fsOverrides?: {
    lstatLogs?: typeof lstat;
}): Promise<ValidatedSandboxBundle>;
/**
 * @param {{ bundlePath: string; output: unknown; status: "finished" | "failed" | "cancelled"; runId?: string; streamLogPath?: string | null; patches?: Array<{ path: string; content: string }>; artifacts?: Array<{ path: string; content: string }>; diffBundle?: unknown; }} params
 */
declare function writeSandboxBundle(params: {
    bundlePath: string;
    output: unknown;
    status: "finished" | "failed" | "cancelled";
    runId?: string;
    streamLogPath?: string | null;
    patches?: Array<{
        path: string;
        content: string;
    }>;
    artifacts?: Array<{
        path: string;
        content: string;
    }>;
    diffBundle?: unknown;
}): Promise<void>;
/** @typedef {import("./SandboxBundleManifest.ts").SandboxBundleManifest} SandboxBundleManifest */
/** @typedef {import("./ValidatedSandboxBundle.ts").ValidatedSandboxBundle} ValidatedSandboxBundle */
declare const SANDBOX_MAX_BUNDLE_BYTES: number;
declare const SANDBOX_MAX_README_BYTES: number;
declare const SANDBOX_MAX_PATCH_FILES: 1000;
declare const SANDBOX_BUNDLE_RUN_ID_MAX_LENGTH: 256;
declare const SANDBOX_BUNDLE_PATH_MAX_LENGTH: 1024;
declare const SANDBOX_BUNDLE_OUTPUT_MAX_DEPTH: 16;
declare const SANDBOX_BUNDLE_OUTPUT_MAX_ARRAY_LENGTH: 512;
declare const SANDBOX_BUNDLE_OUTPUT_MAX_STRING_LENGTH: number;
type SandboxBundleManifest = SandboxBundleManifest$1;
type ValidatedSandboxBundle = ValidatedSandboxBundle$1;

/**
 * @param {unknown} value
 * @returns {import("./SandboxEgressConfig.ts").SandboxEgressConfig | undefined}
 */
declare function normalizeSandboxEgressConfig(value: unknown): SandboxEgressConfig | undefined;
/**
 * @param {unknown} value
 * @param {{ caCertPath?: string }} [options]
 * @returns {Record<string, string>}
 */
declare function sandboxEgressEnv(value: unknown, options?: {
    caCertPath?: string;
}): Record<string, string>;
/**
 * @param {unknown} value
 * @param {string} requestBundlePath
 * @returns {Promise<void>}
 */
declare function writeSandboxEgressFiles(value: unknown, requestBundlePath: string): Promise<void>;
/**
 * @param {unknown} value
 * @returns {unknown}
 */
declare function redactSandboxEgressConfig(value: unknown): unknown;
declare const SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH: ".smithers/egress/ca.crt";
declare const SANDBOX_EGRESS_CA_WORKSPACE_PATH: "/workspace/.smithers/egress/ca.crt";

type SandboxPortMapping = {
    host: number;
    container: number;
};
type SandboxVolumeMount = {
    host: string;
    container: string;
    readonly?: boolean;
};
type SandboxWorkspaceSpec = {
    name: string;
    snapshotId?: string;
    idleTimeoutSecs?: number;
    persistence?: "ephemeral" | "sticky";
};
type SandboxHandle$1 = {
    runtime: SandboxRuntime$1;
    runId: string;
    sandboxId: string;
    sandboxRoot: string;
    requestPath: string;
    resultPath: string;
    image?: string;
    allowNetwork?: boolean;
    env?: Record<string, string>;
    egress?: SandboxEgressConfig;
    ports?: SandboxPortMapping[];
    volumes?: SandboxVolumeMount[];
    memoryLimit?: string;
    cpuLimit?: string;
    workspace?: SandboxWorkspaceSpec;
    containerId?: string;
    workspaceId?: string;
};

type SandboxTransportConfig$1 = {
    runId: string;
    sandboxId: string;
    runtime: SandboxRuntime$1;
    rootDir: string;
    image?: string;
    allowNetwork?: boolean;
    env?: Record<string, string>;
    egress?: SandboxEgressConfig;
    ports?: SandboxPortMapping[];
    volumes?: SandboxVolumeMount[];
    memoryLimit?: string;
    cpuLimit?: string;
    workspace?: SandboxWorkspaceSpec;
};

type SandboxBundleResult$1 = {
    bundlePath: string;
};

/**
 * @param {SandboxProvider} provider
 * @returns {() => void}
 */
declare function registerSandboxProvider(provider: SandboxProvider): () => void;
/**
 * @param {unknown} value
 * @returns {SandboxProvider | undefined}
 */
declare function resolveSandboxProvider(value: unknown): SandboxProvider | undefined;
/**
 * @param {ExecuteSandboxOptions} options
 * @returns {Promise<unknown>}
 */
declare function executeSandbox(options: ExecuteSandboxOptions): Promise<unknown>;
declare namespace __executeSandboxInternals {
    export { fileSize };
    export { diffBundlePatchCount };
    export { isDiffBundleLike };
    export { materializeProviderResult };
    export { requireSandboxHandle };
    export { redactSandboxConfig };
    export { resolveRuntimeDbAdapter };
    export { resolveSandboxProvider };
    export { resolveSandboxCommand };
    export { sandboxExecutionContext };
}
type ExecuteSandboxOptions = ExecuteSandboxOptions$1;
type SandboxHandle = SandboxHandle$1;
type SandboxProvider = SandboxProvider$1;
type SandboxProviderRequest = SandboxProviderRequest$1;
type SandboxProviderResult = SandboxProviderResult$1;
type SmithersEvent = _smithers_orchestrator_observability_SmithersEvent.SmithersEvent;
/**
 * Size in bytes of a single file path (0 if missing or not a regular file).
 * @param {string} path
 * @returns {Promise<number>}
 */
declare function fileSize(path: string): Promise<number>;
/**
 * @param {unknown} value
 * @returns {number}
 */
declare function diffBundlePatchCount(value: unknown): number;
/**
 * @param {unknown} bundle
 * @returns {bundle is import("./SandboxProvider.ts").SandboxDiffBundleLike}
 */
declare function isDiffBundleLike(bundle: unknown): bundle is SandboxDiffBundleLike;
/**
 * @param {SandboxProviderResult} result
 * @param {string} defaultBundlePath
 * @param {string} rootDir
 * @returns {Promise<{ bundlePath: string; remoteRunId: string | null; workspaceId: string | null; containerId: string | null; }>}
 */
declare function materializeProviderResult(result: SandboxProviderResult, defaultBundlePath: string, rootDir: string): Promise<{
    bundlePath: string;
    remoteRunId: string | null;
    workspaceId: string | null;
    containerId: string | null;
}>;
/**
 * @param {SandboxHandle | null} handle
 * @param {string} sandboxId
 * @returns {SandboxHandle}
 */
declare function requireSandboxHandle(handle: SandboxHandle | null, sandboxId: string): SandboxHandle;
/**
 * @param {unknown} config
 */
declare function redactSandboxConfig(config: unknown): unknown;
/**
 * @param {ConstructorParameters<typeof SmithersDb>[0] | SmithersDb} db
 * @returns {SmithersDb}
 */
declare function resolveRuntimeDbAdapter(db: ConstructorParameters<typeof SmithersDb>[0] | SmithersDb): SmithersDb;
/**
 * @param {unknown} command
 * @returns {string}
 */
declare function resolveSandboxCommand(command: unknown): string;
declare const sandboxExecutionContext: AsyncLocalStorage<any>;

/**
 * @template R, E
 * @param {Layer.Layer<SandboxEntityExecutor, E, R>} executorLayer
 * @returns {Layer.Layer<SandboxTransport, E, R>}
 */
declare function makeSandboxTransportLayer<R, E>(executorLayer: Layer.Layer<SandboxEntityExecutor, E, R>): Layer.Layer<SandboxTransport, E, R>;
/**
 * @param {SandboxRuntime} runtime
 */
declare function layerForSandboxRuntime(runtime: SandboxRuntime): Layer.Layer<SandboxTransport, never, never>;
/**
 * @param {SandboxRuntime} requested
 * @returns {SandboxRuntime}
 */
declare function resolveSandboxRuntime(requested: SandboxRuntime): SandboxRuntime;
declare class SandboxTransport {
    constructor(...args: any[]);
}
type SandboxBundleResult = SandboxBundleResult$1;
type SandboxTransportConfig = SandboxTransportConfig$1;
type SandboxRuntime = SandboxRuntime$1;

type SandboxExecOptions$1 = {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
};
type SandboxExecResult$1 = {
    exitCode: number;
    stdout: string;
    stderr: string;
};
type SandboxSession$1 = {
    readonly remoteId: string;
    readonly writeFile: (path: string, content: string) => Promise<void>;
    readonly readFile: (path: string) => Promise<string>;
    readonly exec: (command: string, opts: SandboxExecOptions$1) => Promise<SandboxExecResult$1>;
    readonly destroy?: () => Promise<void>;
};

type SandboxProviderCommandOptions$1 = {
    id: string;
    command?: string;
    workdir?: string;
    requestFile?: string;
    resultFile?: string;
    env?: Record<string, string>;
    cleanup?: "destroy" | "keep";
    createSession: (request: SandboxProviderRequest$1) => Promise<SandboxSession$1> | SandboxSession$1;
};

declare const SANDBOX_PROVIDER_REQUEST_ENV: "SMITHERS_SANDBOX_REQUEST_PATH";

declare const SANDBOX_PROVIDER_RESULT_ENV: "SMITHERS_SANDBOX_RESULT_PATH";

/**
 * Deep-copy a value, replacing any object property whose KEY looks like a
 * secret with "[redacted]". Arrays and nested objects recurse. Cyclic
 * references resolve to "[Circular]" so redaction never loops.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
declare function redactSandboxProviderValue(value: unknown): unknown;

/**
 * Serialize the sandbox request payload the in-sandbox runner reads. Egress is
 * redacted so no raw proxy secrets or CA material land in the request file.
 *
 * @param {import("./SandboxSession.ts").SandboxSession} session
 * @param {string} requestPath
 * @param {import("../SandboxProvider.ts").SandboxProviderRequest} request
 * @returns {Promise<Record<string, unknown>>}
 */
declare function writeSandboxProviderRequestFile(session: SandboxSession$1, requestPath: string, request: SandboxProviderRequest$1): Promise<Record<string, unknown>>;

/**
 * Parse the raw result JSON a sandbox runner produced (from stdout or the
 * result file) into a SandboxProviderResult, filling remote id fields from the
 * session's remoteId when the runner did not supply them.
 *
 * @param {string} raw
 * @param {string} remoteId
 * @param {{ provider?: string; resultPath?: string; secrets?: string[] }} [context]
 * @returns {import("../SandboxProvider.ts").SandboxProviderResult & Record<string, unknown>}
 */
declare function parseSandboxProviderResult(raw: string, remoteId: string, context?: {
    provider?: string;
    resultPath?: string;
    secrets?: string[];
}): SandboxProviderResult$1 & Record<string, unknown>;

/**
 * Materialize an inline egress CA bundle into the sandbox session's workdir so
 * the runner's HTTPS clients can trust the egress proxy. Returns the written
 * path, or null when the egress config carries no inline PEM.
 *
 * @param {import("./SandboxSession.ts").SandboxSession} session
 * @param {import("../SandboxEgressConfig.ts").SandboxEgressConfig | undefined} egress
 * @param {string} workdir
 * @returns {Promise<string | null>}
 */
declare function uploadEgressCaToSession(session: SandboxSession$1, egress: SandboxEgressConfig | undefined, workdir: string): Promise<string | null>;

/**
 * Build a SandboxProvider that runs a command inside a remote session managed
 * through the small SandboxSession seam. Vendor providers supply a createSession
 * factory; the kit handles request shipping, egress, result parsing, secret
 * scrubbing, and cleanup uniformly.
 *
 * @param {import("./SandboxProviderCommandOptions.ts").SandboxProviderCommandOptions} options
 * @returns {import("../SandboxProvider.ts").SandboxProvider}
 */
declare function createCommandSandboxProvider(options: SandboxProviderCommandOptions$1): SandboxProvider$1;

/**
 * Define a reusable bun:test contract suite that every command-backed sandbox
 * provider package can run against its own createProvider factory. It exercises
 * the happy path and the SandboxProvider shape invariants. Exhaustive
 * error/redaction/timeout paths live in the kit's own unit test, not here.
 *
 * @param {{
 *   name: string;
 *   expectedProviderId: string;
 *   createProvider: (
 *     handler: (args: { command: string; request: Record<string, unknown>; files: Map<string, string>; env: Record<string, string> }) => import("../SandboxProvider.ts").SandboxProviderResult | Promise<import("../SandboxProvider.ts").SandboxProviderResult>,
 *     providerOptions?: Record<string, unknown>,
 *   ) => import("../SandboxProvider.ts").SandboxProvider;
 *   createRequest?: (overrides?: Record<string, unknown>) => { request: import("../SandboxProvider.ts").SandboxProviderRequest; heartbeats: unknown[] };
 * }} config
 * @returns {void}
 */
declare function createSandboxProviderContractSuite(config: {
    name: string;
    expectedProviderId: string;
    createProvider: (handler: (args: {
        command: string;
        request: Record<string, unknown>;
        files: Map<string, string>;
        env: Record<string, string>;
    }) => SandboxProviderResult$1 | Promise<SandboxProviderResult$1>, providerOptions?: Record<string, unknown>) => SandboxProvider$1;
    createRequest?: (overrides?: Record<string, unknown>) => {
        request: SandboxProviderRequest$1;
        heartbeats: unknown[];
    };
}): void;

type SandboxExecOptions = SandboxExecOptions$1;
type SandboxExecResult = SandboxExecResult$1;
type SandboxSession = SandboxSession$1;
type SandboxProviderCommandOptions = SandboxProviderCommandOptions$1;

export { type ExecuteSandboxOptions, SANDBOX_BUNDLE_OUTPUT_MAX_ARRAY_LENGTH, SANDBOX_BUNDLE_OUTPUT_MAX_DEPTH, SANDBOX_BUNDLE_OUTPUT_MAX_STRING_LENGTH, SANDBOX_BUNDLE_PATH_MAX_LENGTH, SANDBOX_BUNDLE_RUN_ID_MAX_LENGTH, SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH, SANDBOX_EGRESS_CA_WORKSPACE_PATH, SANDBOX_MAX_BUNDLE_BYTES, SANDBOX_MAX_PATCH_FILES, SANDBOX_MAX_README_BYTES, SANDBOX_PROVIDER_REQUEST_ENV, SANDBOX_PROVIDER_RESULT_ENV, type SandboxBundleManifest, type SandboxBundleResult, type SandboxExecOptions, type SandboxExecResult, type SandboxProvider, type SandboxProviderCommandOptions, type SandboxProviderRequest, type SandboxProviderResult, type SandboxSession, SandboxTransport, type SandboxTransportConfig, type SmithersEvent, type ValidatedSandboxBundle, __executeSandboxInternals, createCommandSandboxProvider, createSandboxProviderContractSuite, executeSandbox, layerForSandboxRuntime, makeSandboxTransportLayer, normalizeSandboxEgressConfig, parseSandboxProviderResult, redactSandboxEgressConfig, redactSandboxProviderValue, registerSandboxProvider, resolveSandboxProvider, resolveSandboxRuntime, sandboxEgressEnv, uploadEgressCaToSession, validateSandboxBundle, writeSandboxBundle, writeSandboxEgressFiles, writeSandboxProviderRequestFile };
