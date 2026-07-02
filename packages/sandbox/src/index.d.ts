import * as _smithers_observability_SmithersEvent from '@smithers-orchestrator/observability/SmithersEvent';
import { Context, Effect, Layer } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';

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
 * @returns {Promise<ValidatedSandboxBundle>}
 */
declare function validateSandboxBundle(bundlePath: string): Promise<ValidatedSandboxBundle>;
/**
 * @param {{ bundlePath: string; output: unknown; status: "finished" | "failed" | "cancelled"; runId?: string; streamLogPath?: string | null; patches?: Array<{ path: string; content: string }>; artifacts?: Array<{ path: string; content: string }>; }} params
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

type SandboxRuntime$1 = "bubblewrap" | "docker" | "codeplane" | "cloudflare";

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
type SandboxEgressConfig = {
    env?: Record<string, string>;
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string | string[];
    caCertPem?: string;
    caCertPath?: string;
    secretBindings?: Record<string, string>;
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

type SandboxHandle = {
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

type SandboxBundleResult$1 = {
    bundlePath: string;
};

type SandboxTransportService = {
    readonly create: (config: SandboxTransportConfig$1) => Effect.Effect<SandboxHandle, SmithersError>;
    readonly ship: (bundlePath: string, handle: SandboxHandle) => Effect.Effect<void, SmithersError>;
    readonly execute: (command: string, handle: SandboxHandle) => Effect.Effect<{
        exitCode: number;
    }, SmithersError>;
    readonly collect: (handle: SandboxHandle) => Effect.Effect<SandboxBundleResult$1, SmithersError>;
    readonly cleanup: (handle: SandboxHandle) => Effect.Effect<void, SmithersError>;
};

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
type SandboxProviderRequest = {
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
type SandboxProviderResult = {
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
type SandboxProvider = {
    id: string;
    run: (request: SandboxProviderRequest) => Promise<SandboxProviderResult> | SandboxProviderResult;
    cleanup?: (request: SandboxProviderRequest) => Promise<void> | void;
};
type ExecuteSandboxOptions$1 = {
    parentWorkflow?: SandboxWorkflow;
    sandboxId: string;
    provider?: SandboxProvider | string;
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

declare function registerSandboxProvider(provider: SandboxProvider): () => void;
declare function resolveSandboxProvider(value: unknown): SandboxProvider | undefined;

/**
 * @param {ExecuteSandboxOptions} options
 * @returns {Promise<unknown>}
 */
declare function executeSandbox(options: ExecuteSandboxOptions): Promise<unknown>;
type ExecuteSandboxOptions = ExecuteSandboxOptions$1;
type SmithersEvent = _smithers_observability_SmithersEvent.SmithersEvent;

declare const SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH = ".smithers/egress/ca.crt";
declare const SANDBOX_EGRESS_CA_WORKSPACE_PATH = "/workspace/.smithers/egress/ca.crt";
declare function normalizeSandboxEgressConfig(value: unknown): SandboxEgressConfig | undefined;
declare function sandboxEgressEnv(value: unknown, options?: {
    caCertPath?: string;
}): Record<string, string>;
declare function writeSandboxEgressFiles(value: unknown, requestBundlePath: string): Promise<void>;
declare function redactSandboxEgressConfig(value: unknown): unknown;

declare class SandboxEntityExecutor extends Context.TagClassShape<"SandboxEntityExecutor", SandboxTransportService> {
}

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
declare class SandboxTransport extends Context.TagClassShape<"SandboxTransport", SandboxTransportService> {
}
type SandboxBundleResult = SandboxBundleResult$1;
type SandboxTransportConfig = SandboxTransportConfig$1;
type SandboxRuntime = SandboxRuntime$1;

export { type ExecuteSandboxOptions, SANDBOX_BUNDLE_OUTPUT_MAX_ARRAY_LENGTH, SANDBOX_BUNDLE_OUTPUT_MAX_DEPTH, SANDBOX_BUNDLE_OUTPUT_MAX_STRING_LENGTH, SANDBOX_BUNDLE_PATH_MAX_LENGTH, SANDBOX_BUNDLE_RUN_ID_MAX_LENGTH, SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH, SANDBOX_EGRESS_CA_WORKSPACE_PATH, SANDBOX_MAX_BUNDLE_BYTES, SANDBOX_MAX_PATCH_FILES, SANDBOX_MAX_README_BYTES, type SandboxBundleManifest, type SandboxBundleResult, type SandboxBundleStatus, type SandboxDiffBundleLike, type SandboxEgressConfig, type SandboxProvider, type SandboxProviderRequest, type SandboxProviderResult, SandboxTransport, type SandboxTransportConfig, type SmithersEvent, type ValidatedSandboxBundle, executeSandbox, layerForSandboxRuntime, makeSandboxTransportLayer, normalizeSandboxEgressConfig, redactSandboxEgressConfig, registerSandboxProvider, resolveSandboxProvider, resolveSandboxRuntime, sandboxEgressEnv, validateSandboxBundle, writeSandboxBundle, writeSandboxEgressFiles };
