import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Metric } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { trackEvent, sandboxTransportDurationMs } from "@smithers-orchestrator/observability/metrics";
import { logWarning } from "@smithers-orchestrator/observability/logging";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { errorToJson } from "@smithers-orchestrator/errors/errorToJson";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { validateSandboxBundle, writeSandboxBundle } from "./bundle.js";
import { resolveSandboxPath } from "./sandboxPath.js";
import { normalizeSandboxEgressConfig, redactSandboxEgressConfig, writeSandboxEgressFiles } from "./egress.js";
import { SandboxTransport, layerForSandboxRuntime, resolveSandboxRuntime, } from "./transport.js";
/** @typedef {import("./ExecuteSandboxOptions.ts").ExecuteSandboxOptions} ExecuteSandboxOptions */
/** @typedef {import("./SandboxRuntime.ts").SandboxRuntime} SandboxRuntime */
/** @typedef {import("./SandboxHandle.ts").SandboxHandle} SandboxHandle */
/** @typedef {import("./SandboxTransportService.ts").SandboxTransportService} SandboxTransportService */
/** @typedef {import("./SandboxProvider.ts").SandboxProvider} SandboxProvider */
/** @typedef {import("./SandboxProvider.ts").SandboxProviderRequest} SandboxProviderRequest */
/** @typedef {import("./SandboxProvider.ts").SandboxProviderResult} SandboxProviderResult */
/** @typedef {import("@smithers-orchestrator/observability/SmithersEvent").SmithersEvent} SmithersEvent */

const DEFAULT_MAX_CONCURRENT_SANDBOXES = 10;
// What a shipped bundle runs when config.command is absent or blank.
const DEFAULT_SANDBOX_COMMAND = "smithers up bundle.tsx";
const sandboxProviderRegistry = new Map();
const sandboxExecutionContext = new AsyncLocalStorage();

/**
 * @param {SandboxProvider} provider
 * @returns {() => void}
 */
export function registerSandboxProvider(provider) {
    if (!provider || typeof provider !== "object" || typeof provider.run !== "function") {
        throw new SmithersError("INVALID_INPUT", "Sandbox provider must be an object with a run(request) function.");
    }
    if (typeof provider.id !== "string" || provider.id.trim().length === 0) {
        throw new SmithersError("INVALID_INPUT", "Sandbox provider must include a non-empty id.");
    }
    const id = provider.id.trim();
    sandboxProviderRegistry.set(id, { ...provider, id });
    return () => {
        if (sandboxProviderRegistry.get(id)?.run === provider.run) {
            sandboxProviderRegistry.delete(id);
        }
    };
}

/**
 * @param {unknown} value
 * @returns {SandboxProvider | undefined}
 */
export function resolveSandboxProvider(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === "string") {
        const provider = sandboxProviderRegistry.get(value);
        if (!provider) {
            throw new SmithersError("INVALID_INPUT", `Sandbox provider "${value}" is not registered.`, { provider: value });
        }
        return provider;
    }
    if (typeof value === "object" && typeof value.run === "function") {
        const id = typeof value.id === "string" && value.id.trim().length > 0
            ? value.id.trim()
            : "custom";
        return { ...value, id };
    }
    throw new SmithersError("INVALID_INPUT", "Sandbox provider must be a registered provider id or a provider object.", { providerType: typeof value });
}
/**
 * @param {unknown} value
 * @returns {value is SmithersDb}
 */
function isSmithersDbAdapter(value) {
    return Boolean(value &&
        typeof value === "object" &&
        typeof value.insertEventWithNextSeq === "function" &&
        typeof value.listSandboxes === "function");
}
/**
 * @param {ConstructorParameters<typeof SmithersDb>[0] | SmithersDb} db
 * @returns {SmithersDb}
 */
function resolveRuntimeDbAdapter(db) {
    return isSmithersDbAdapter(db) ? db : new SmithersDb(db);
}
/**
 * @param {ConstructorParameters<typeof SmithersDb>[0]} db
 * @param {SmithersEvent} event
 * @returns {Promise<void>}
 */
async function emitSandboxEvent(db, event) {
    const adapter = resolveRuntimeDbAdapter(db);
    await adapter.insertEventWithNextSeq({
        runId: event.runId,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson: JSON.stringify(event),
    });
    await Effect.runPromise(trackEvent(event));
}
/**
 * Size in bytes of a single file path (0 if missing or not a regular file).
 * @param {string} path
 * @returns {Promise<number>}
 */
async function fileSize(path) {
    const info = await stat(path).catch(() => null);
    if (!info)
        return 0;
    if (info.isFile())
        return info.size;
    return 0;
}
/**
 * @template A
 * @param {(runtime: SandboxRuntime) => import("effect").Layer.Layer<SandboxTransport>} layerFor
 * @param {SandboxRuntime} runtime
 * @param {Effect.Effect<A, SmithersError, SandboxTransport>} effect
 * @returns {Promise<A>}
 */
async function transportCall(layerFor, runtime, effect) {
    const started = performance.now();
    const value = await Effect.runPromise(effect.pipe(Effect.provide(layerFor(runtime))));
    await Effect.runPromise(Metric.update(sandboxTransportDurationMs, performance.now() - started));
    return value;
}
/**
 * @template A
 * @param {(svc: SandboxTransportService) => Effect.Effect<A, SmithersError>} fn
 * @returns {Effect.Effect<A, SmithersError, SandboxTransport>}
 */
function sandboxTransport(fn) {
    return Effect.flatMap(SandboxTransport, fn);
}
/**
 * @param {SandboxHandle | null} handle
 * @param {string} sandboxId
 * @returns {SandboxHandle}
 */
function requireSandboxHandle(handle, sandboxId) {
    if (handle)
        return handle;
    throw new SmithersError("SANDBOX_EXECUTION_FAILED", `Sandbox ${sandboxId} did not initialize correctly.`, { sandboxId });
}
/**
 * @param {unknown} command
 * @returns {string}
 */
function resolveSandboxCommand(command) {
    return typeof command === "string" && command.trim().length > 0
        ? command
        : DEFAULT_SANDBOX_COMMAND;
}
/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asPlainObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? /** @type {Record<string, unknown>} */ (value)
        : null;
}
/**
 * @param {unknown} value
 * @returns {number}
 */
function diffBundlePatchCount(value) {
    const bundle = asPlainObject(value);
    const patches = Array.isArray(bundle?.patches) ? bundle.patches : [];
    return patches.length;
}
/**
 * @param {string} diff
 * @returns {number}
 */
function unifiedDiffLineCount(diff) {
    let count = 0;
    for (const line of diff.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) {
            continue;
        }
        if (line.startsWith("+") || line.startsWith("-")) {
            count += 1;
        }
    }
    return count;
}
/**
 * @param {unknown} status
 * @returns {status is "finished" | "failed" | "cancelled"}
 */
function isSandboxBundleStatus(status) {
    return status === "finished" || status === "failed" || status === "cancelled";
}
/**
 * A sandbox provider result is produced by untrusted code running inside the
 * sandbox. `streamLogPath`, when present, is a HOST path the orchestrator will
 * read and copy into the run bundle's logs/stream.ndjson. Confine it to the run
 * root so a hostile sandbox cannot name an arbitrary host file (e.g. /etc/passwd,
 * ~/.aws/credentials, ~/.ssh/id_rsa) and exfiltrate its contents into the
 * collected bundle. Returns the resolved in-root path, or null when absent.
 * Throws TOOL_PATH_ESCAPE when the path escapes the run root.
 * @param {unknown} streamLogPath
 * @param {string} rootDir
 * @returns {string | null}
 */
function resolveProviderStreamLogPath(streamLogPath, rootDir) {
    if (typeof streamLogPath !== "string" || streamLogPath.length === 0) {
        return null;
    }
    return resolveSandboxPath(rootDir, streamLogPath);
}
/**
 * @param {SandboxProviderResult} result
 * @param {string} defaultBundlePath
 * @param {string} rootDir
 * @returns {Promise<{ bundlePath: string; remoteRunId: string | null; workspaceId: string | null; containerId: string | null; }>}
 */
async function materializeProviderResult(result, defaultBundlePath, rootDir) {
    const source = asPlainObject(result);
    if (!source) {
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", "Sandbox provider returned an invalid result.");
    }
    if (typeof source.bundlePath === "string" && source.bundlePath.length > 0) {
        return {
            bundlePath: source.bundlePath,
            remoteRunId: typeof source.remoteRunId === "string" ? source.remoteRunId : null,
            workspaceId: typeof source.workspaceId === "string" ? source.workspaceId : null,
            containerId: typeof source.containerId === "string" ? source.containerId : null,
        };
    }
    if (!isSandboxBundleStatus(source.status)) {
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", "Sandbox provider result must include either bundlePath or status.", {
            status: source.status,
        });
    }
    const remoteRunId = typeof source.remoteRunId === "string"
        ? source.remoteRunId
        : typeof source.runId === "string"
            ? source.runId
            : null;
    await writeSandboxBundle({
        bundlePath: defaultBundlePath,
        output: source.outputs ?? source.output,
        status: source.status,
        runId: remoteRunId ?? undefined,
        streamLogPath: resolveProviderStreamLogPath(source.streamLogPath, rootDir),
        patches: Array.isArray(source.patches) ? source.patches : undefined,
        artifacts: Array.isArray(source.artifacts) ? source.artifacts : undefined,
        diffBundle: source.diffBundle,
    });
    return {
        bundlePath: defaultBundlePath,
        remoteRunId,
        workspaceId: typeof source.workspaceId === "string" ? source.workspaceId : null,
        containerId: typeof source.containerId === "string" ? source.containerId : null,
    };
}
/**
 * @param {SandboxProvider} provider
 * @param {SandboxProviderRequest} request
 * @returns {Promise<SandboxProviderResult>}
 */
async function runSandboxProvider(provider, request) {
    return sandboxExecutionContext.run({
        depth: (sandboxExecutionContext.getStore()?.depth ?? 0) + 1,
        sandboxId: request.sandboxId,
        runId: request.runId,
        providerId: provider.id,
    }, async () => provider.run(request));
}
/**
 * @param {unknown} bundle
 * @returns {bundle is import("./SandboxProvider.ts").SandboxDiffBundleLike}
 */
function isDiffBundleLike(bundle) {
    const source = asPlainObject(bundle);
    return Boolean(source &&
        typeof source.seq === "number" &&
        typeof source.baseRef === "string" &&
        Array.isArray(source.patches));
}
/**
 * @param {import("./ValidatedSandboxBundle.ts").ValidatedSandboxBundle} validated
 * @returns {Promise<number>}
 */
async function sandboxDiffLineCount(validated) {
    let total = 0;
    for (const patchPath of validated.patchFiles) {
        const content = await readFile(resolveSandboxPath(validated.bundlePath, patchPath), "utf8").catch(() => "");
        total += unifiedDiffLineCount(content);
    }
    const diffBundle = validated.manifest.diffBundle;
    if (isDiffBundleLike(diffBundle)) {
        for (const patch of diffBundle.patches) {
            if (typeof patch?.diff === "string") {
                total += unifiedDiffLineCount(patch.diff);
            }
        }
    }
    return total;
}
/**
 * @param {import("./ValidatedSandboxBundle.ts").ValidatedSandboxBundle} validated
 * @param {ExecuteSandboxOptions} options
 */
async function applyAcceptedSandboxChanges(validated, options) {
    const diffBundle = validated.manifest.diffBundle;
    if (diffBundle === undefined) {
        return;
    }
    if (!isDiffBundleLike(diffBundle)) {
        throw new SmithersError("INVALID_INPUT", "Sandbox bundle diffBundle is malformed.", {
            sandboxId: options.sandboxId,
        });
    }
    if (typeof options.applyDiffBundle !== "function") {
        throw new SmithersError("INVALID_INPUT", "Sandbox bundle contains a diffBundle but no diff applier was provided.", {
            sandboxId: options.sandboxId,
        });
    }
    await options.applyDiffBundle(diffBundle, options.rootDir);
}
/**
 * @param {unknown} config
 */
function redactSandboxConfig(config) {
    const source = asPlainObject(config);
    if (!source) {
        return config;
    }
    const redacted = { ...source };
    const env = asPlainObject(source.env);
    if (env) {
        redacted.env = Object.fromEntries(Object.keys(env).sort().map((key) => [key, "[redacted]"]));
    }
    if (source.egress !== undefined) {
        redacted.egress = redactSandboxEgressConfig(source.egress);
    }
    return redacted;
}
export const __executeSandboxInternals = {
    fileSize,
    diffBundlePatchCount,
    isDiffBundleLike,
    materializeProviderResult,
    requireSandboxHandle,
    redactSandboxConfig,
    resolveRuntimeDbAdapter,
    resolveSandboxProvider,
    resolveSandboxCommand,
    sandboxExecutionContext,
};
/**
 * @returns {number}
 */
function resolveMaxConcurrentSandboxes() {
    const raw = process.env.SMITHERS_MAX_CONCURRENT_SANDBOXES;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_MAX_CONCURRENT_SANDBOXES;
    }
    return Math.floor(parsed);
}
/**
 * @param {unknown} status
 * @returns {boolean}
 */
function isSandboxActive(status) {
    if (typeof status !== "string")
        return false;
    return status !== "finished" && status !== "failed" && status !== "cancelled";
}
/**
 * Shared completion tail for both execution paths (provider and transport):
 * record the collected bundle, run the diff-review gate, apply accepted
 * changes, and mark the sandbox row, events, and heartbeat as completed.
 * @param {{
 *   adapter: SmithersDb;
 *   runtimeDb: ConstructorParameters<typeof SmithersDb>[0];
 *   runtime: ReturnType<typeof requireTaskRuntime>;
 *   options: ExecuteSandboxOptions;
 *   selectedRuntime: string;
 *   configJson: string;
 *   createdAtMs: number;
 *   childStartedMs: number;
 *   validated: import("./ValidatedSandboxBundle.ts").ValidatedSandboxBundle;
 *   remoteRunId: string | undefined;
 *   workspaceId: string | null;
 *   containerId: string | null;
 *   requireApprovalMessage: string;
 * }} params
 * @returns {Promise<unknown>}
 */
async function finalizeSandboxBundle(params) {
    const { adapter, runtimeDb, runtime, options, selectedRuntime, configJson, validated } = params;
    const totalPatchCount = validated.patchFiles.length + diffBundlePatchCount(validated.manifest.diffBundle);
    runtime.heartbeat({
        sandboxId: options.sandboxId,
        stage: "bundle-collected",
        progress: 85,
        bundlePath: validated.bundlePath,
        patchCount: totalPatchCount,
    });
    await emitSandboxEvent(runtimeDb, {
        type: "SandboxBundleReceived",
        runId: runtime.runId,
        sandboxId: options.sandboxId,
        bundleSizeBytes: validated.bundleSizeBytes,
        patchCount: totalPatchCount,
        hasOutputs: validated.manifest.outputs !== undefined,
        timestampMs: nowMs(),
    });
    const reviewDiffs = options.reviewDiffs ?? true;
    if (reviewDiffs && totalPatchCount > 0) {
        const totalDiffLines = await sandboxDiffLineCount(validated);
        await emitSandboxEvent(runtimeDb, {
            type: "SandboxDiffReviewRequested",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            patchCount: totalPatchCount,
            totalDiffLines,
            timestampMs: nowMs(),
        });
        if (!options.autoAcceptDiffs) {
            await emitSandboxEvent(runtimeDb, {
                type: "SandboxDiffRejected",
                runId: runtime.runId,
                sandboxId: options.sandboxId,
                reason: "Diff review approval is required before applying sandbox patches.",
                timestampMs: nowMs(),
            });
            throw new SmithersError("INVALID_INPUT", params.requireApprovalMessage, {
                sandboxId: options.sandboxId,
                patchCount: totalPatchCount,
            });
        }
        await emitSandboxEvent(runtimeDb, {
            type: "SandboxDiffAccepted",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            patchCount: totalPatchCount,
            timestampMs: nowMs(),
        });
    }
    if (!reviewDiffs || totalPatchCount === 0 || options.autoAcceptDiffs) {
        await applyAcceptedSandboxChanges(validated, options);
    }
    await adapter.upsertSandbox({
        runId: runtime.runId,
        sandboxId: options.sandboxId,
        runtime: selectedRuntime,
        remoteRunId: params.remoteRunId ?? null,
        workspaceId: params.workspaceId,
        containerId: params.containerId,
        configJson,
        status: validated.manifest.status,
        shippedAtMs: params.createdAtMs,
        completedAtMs: nowMs(),
        bundlePath: validated.bundlePath,
    });
    await emitSandboxEvent(runtimeDb, {
        type: "SandboxCompleted",
        runId: runtime.runId,
        sandboxId: options.sandboxId,
        // Deliberately not `?? null`: an undefined remoteRunId is dropped by
        // JSON.stringify, preserving the historical event payload shape.
        remoteRunId: params.remoteRunId,
        runtime: selectedRuntime,
        status: validated.manifest.status,
        durationMs: performance.now() - params.childStartedMs,
        timestampMs: nowMs(),
    });
    runtime.heartbeat({
        sandboxId: options.sandboxId,
        stage: "completed",
        progress: 100,
        status: validated.manifest.status,
    });
    return validated.manifest.outputs;
}
/**
 * @param {ExecuteSandboxOptions} options
 * @returns {Promise<unknown>}
 */
export async function executeSandbox(options) {
    const runtime = requireTaskRuntime();
    const parentSandbox = sandboxExecutionContext.getStore();
    if (parentSandbox && !options.allowNested) {
        throw new SmithersError("INVALID_INPUT", "Nested <Sandbox> execution is disabled by default. Set allowNested on the nested sandbox only if the provider and diff policy are explicitly designed for nesting.", {
            sandboxId: options.sandboxId,
            parentSandboxId: parentSandbox.sandboxId,
            parentRunId: parentSandbox.runId,
            parentProviderId: parentSandbox.providerId,
        });
    }
    runtime.heartbeat({
        sandboxId: options.sandboxId,
        stage: "initializing",
        progress: 0,
    });
    const runtimeDb = runtime.db ?? options.parentWorkflow?.db;
    if (!runtimeDb) {
        throw new SmithersError("TASK_RUNTIME_UNAVAILABLE", "Sandbox execution requires a task runtime database.", {
            sandboxId: options.sandboxId,
        });
    }
    const adapter = resolveRuntimeDbAdapter(runtimeDb);
    const provider = resolveSandboxProvider(options.provider);
    const requestedRuntime = options.runtime;
    const selectedRuntime = provider ? provider.id : resolveSandboxRuntime(requestedRuntime ?? "bubblewrap");
    // Sandbox transport layer resolver. Defaults to the built-in runtime layers;
    // an injected resolver lets callers/tests supply an alternate transport
    // implementation without changing the runtime selection logic.
    const transportLayerFor = typeof options.transportLayerFor === "function"
        ? options.transportLayerFor
        : layerForSandboxRuntime;
    const createdAtMs = nowMs();
    const rawConfig = asPlainObject(options.config) ?? {};
    const egress = normalizeSandboxEgressConfig(rawConfig.egress);
    const configJson = JSON.stringify({
        provider: provider?.id,
        runtime: requestedRuntime ?? (provider ? undefined : selectedRuntime),
        selectedRuntime,
        allowNetwork: options.allowNetwork,
        maxOutputBytes: options.maxOutputBytes,
        toolTimeoutMs: options.toolTimeoutMs,
        reviewDiffs: options.reviewDiffs ?? true,
        autoAcceptDiffs: Boolean(options.autoAcceptDiffs),
        ...redactSandboxConfig(rawConfig),
    });
    const sandboxRoot = join(options.rootDir, ".smithers", "sandboxes", runtime.runId, options.sandboxId);
    const requestBundlePath = join(sandboxRoot, "request-bundle");
    let handle = null;
    let providerRequest = null;
    try {
        const existingSandboxes = await adapter.listSandboxes(runtime.runId);
        const activeSandboxCount = existingSandboxes.filter((row) => isSandboxActive(row?.status)).length;
        const maxConcurrent = resolveMaxConcurrentSandboxes();
        if (activeSandboxCount >= maxConcurrent) {
            throw new SmithersError("SANDBOX_EXECUTION_FAILED", `Sandbox concurrency limit reached for run ${runtime.runId} (${maxConcurrent}).`, {
                runId: runtime.runId,
                maxConcurrent,
                activeSandboxCount,
            });
        }
        await adapter.upsertSandbox({
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            remoteRunId: null,
            workspaceId: null,
            containerId: null,
            configJson,
            status: "pending",
            shippedAtMs: null,
            completedAtMs: null,
            bundlePath: null,
        });
        await emitSandboxEvent(runtimeDb, {
            type: "SandboxCreated",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            configJson,
            timestampMs: createdAtMs,
        });
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "created",
            progress: 10,
        });
        await mkdir(requestBundlePath, { recursive: true });
        await writeFile(join(requestBundlePath, "README.md"), JSON.stringify({
            status: "pending",
            sandboxId: options.sandboxId,
            provider: selectedRuntime,
            runtime: options.runtime ?? selectedRuntime,
            input: options.input ?? {},
        }, null, 2), "utf8");
        await writeSandboxEgressFiles(egress, requestBundlePath);
        if (provider) {
            const bundleSizeBytes = await fileSize(join(requestBundlePath, "README.md"));
            await emitSandboxEvent(runtimeDb, {
                type: "SandboxShipped",
                runId: runtime.runId,
                sandboxId: options.sandboxId,
                runtime: selectedRuntime,
                bundleSizeBytes,
                timestampMs: nowMs(),
            });
            runtime.heartbeat({
                sandboxId: options.sandboxId,
                stage: "shipped",
                progress: 25,
            });
            await adapter.upsertSandbox({
                runId: runtime.runId,
                sandboxId: options.sandboxId,
                runtime: selectedRuntime,
                remoteRunId: null,
                workspaceId: null,
                containerId: null,
                configJson,
                status: "shipped",
                shippedAtMs: nowMs(),
                completedAtMs: null,
                bundlePath: null,
            });
            runtime.heartbeat({
                sandboxId: options.sandboxId,
                stage: "executing",
                progress: 40,
            });
            const childStartedMs = performance.now();
            providerRequest = {
                runId: runtime.runId,
                sandboxId: options.sandboxId,
                input: options.input,
                rootDir: options.rootDir,
                requestBundlePath,
                resultBundlePath: join(sandboxRoot, "result"),
                workflow: options.workflow,
                parentWorkflow: options.parentWorkflow,
                executeChildWorkflow: options.executeChildWorkflow,
                allowNetwork: options.allowNetwork,
                maxOutputBytes: options.maxOutputBytes,
                toolTimeoutMs: options.toolTimeoutMs,
                egress,
                config: rawConfig,
                signal: runtime.signal,
                heartbeat: runtime.heartbeat,
            };
            const providerResult = await runSandboxProvider(provider, providerRequest);
            const materialized = await materializeProviderResult(providerResult, providerRequest.resultBundlePath, options.rootDir);
            const validated = await validateSandboxBundle(materialized.bundlePath);
            return await finalizeSandboxBundle({
                adapter,
                runtimeDb,
                runtime,
                options,
                selectedRuntime,
                configJson,
                createdAtMs,
                childStartedMs,
                validated,
                remoteRunId: materialized.remoteRunId ?? validated.manifest.runId,
                workspaceId: materialized.workspaceId,
                containerId: materialized.containerId,
                requireApprovalMessage: "Sandbox produced changes that require review approval.",
            });
        }
        const transportConfig = {
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            rootDir: options.rootDir,
            image: typeof rawConfig.image === "string" ? rawConfig.image : undefined,
            allowNetwork: options.allowNetwork,
            env: rawConfig.env,
            egress,
            ports: rawConfig.ports,
            volumes: rawConfig.volumes,
            memoryLimit: rawConfig.memoryLimit,
            cpuLimit: rawConfig.cpuLimit,
            workspace: rawConfig.workspace,
        };
        handle = await transportCall(transportLayerFor, selectedRuntime, sandboxTransport((svc) => svc.create(transportConfig)));
        const sandboxHandle = requireSandboxHandle(handle, options.sandboxId);
        await transportCall(transportLayerFor, selectedRuntime, sandboxTransport((svc) => svc.ship(requestBundlePath, sandboxHandle)));
        const bundleSizeBytes = await fileSize(join(requestBundlePath, "README.md"));
        await emitSandboxEvent(runtimeDb, {
            type: "SandboxShipped",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            bundleSizeBytes,
            timestampMs: nowMs(),
        });
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "shipped",
            progress: 25,
        });
        await adapter.upsertSandbox({
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            remoteRunId: null,
            workspaceId: sandboxHandle.workspaceId ?? null,
            containerId: sandboxHandle.containerId ?? null,
            configJson,
            status: "shipped",
            shippedAtMs: nowMs(),
            completedAtMs: null,
            bundlePath: null,
        });
        if (options.config?.command) {
            await transportCall(transportLayerFor, selectedRuntime, sandboxTransport((svc) => svc.execute(resolveSandboxCommand(options.config?.command), sandboxHandle, runtime.signal)));
        }
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "executing",
            progress: 40,
        });
        if (typeof options.executeChildWorkflow !== "function") {
            throw new SmithersError("INVALID_INPUT", `Sandbox ${options.sandboxId} is missing a child workflow executor.`, { sandboxId: options.sandboxId });
        }
        const childStartedMs = performance.now();
        const child = await sandboxExecutionContext.run({
            depth: (sandboxExecutionContext.getStore()?.depth ?? 0) + 1,
            sandboxId: options.sandboxId,
            runId: runtime.runId,
            providerId: selectedRuntime,
        }, async () => options.executeChildWorkflow(options.parentWorkflow, {
            workflow: options.workflow,
            input: options.input,
            parentRunId: runtime.runId,
            rootDir: options.rootDir,
            allowNetwork: options.allowNetwork,
            maxOutputBytes: options.maxOutputBytes,
            toolTimeoutMs: options.toolTimeoutMs,
            signal: runtime.signal,
        }));
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "child-finished",
            progress: 70,
            childRunId: child.runId,
            childStatus: child.status,
        });
        await emitSandboxEvent(runtimeDb, {
            type: "SandboxHeartbeat",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            remoteRunId: child.runId,
            progress: 1,
            timestampMs: nowMs(),
        });
        await writeSandboxBundle({
            bundlePath: sandboxHandle.resultPath,
            output: child.output,
            status: child.status === "finished" ? "finished" : "failed",
            runId: child.runId,
            // The child run's live stream log, copied into the result bundle.
            streamLogPath: join(options.rootDir, ".smithers", "executions", child.runId, "logs", "stream.ndjson"),
        });
        const collected = await transportCall(transportLayerFor, selectedRuntime, sandboxTransport((svc) => svc.collect(sandboxHandle)));
        const validated = await validateSandboxBundle(collected.bundlePath);
        return await finalizeSandboxBundle({
            adapter,
            runtimeDb,
            runtime,
            options,
            selectedRuntime,
            configJson,
            createdAtMs,
            childStartedMs,
            validated,
            remoteRunId: child.runId,
            workspaceId: sandboxHandle.workspaceId ?? null,
            containerId: sandboxHandle.containerId ?? null,
            requireApprovalMessage: "Sandbox produced patches that require review approval.",
        });
    }
    catch (error) {
        await adapter.upsertSandbox({
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            remoteRunId: null,
            workspaceId: handle?.workspaceId ?? null,
            containerId: handle?.containerId ?? null,
            configJson,
            status: "failed",
            shippedAtMs: createdAtMs,
            completedAtMs: nowMs(),
            bundlePath: handle?.resultPath ?? null,
        });
        await emitSandboxEvent(runtimeDb, {
            type: "SandboxFailed",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            error: errorToJson(error),
            timestampMs: nowMs(),
        });
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "failed",
            progress: 100,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
    finally {
        // Teardown must never mask the primary result (success or failure) and must
        // never escape as a rejection from the finally block — but a swallowed cleanup
        // failure can hide leaked resources (orphaned containers, undeleted workspaces),
        // so surface it as a WARNING instead of discarding it silently.
        if (handle) {
            await transportCall(transportLayerFor, selectedRuntime, sandboxTransport((svc) => svc.cleanup(handle))).catch((cleanupError) => {
                logWarning("sandbox transport cleanup failed", {
                    runId: runtime.runId,
                    sandboxId: options.sandboxId,
                    runtime: selectedRuntime,
                    error: errorToJson(cleanupError),
                });
            });
        }
        if (provider && providerRequest && typeof provider.cleanup === "function") {
            await Promise.resolve(provider.cleanup(providerRequest)).catch((cleanupError) => {
                logWarning("sandbox provider cleanup failed", {
                    runId: runtime.runId,
                    sandboxId: options.sandboxId,
                    provider: provider.id,
                    error: errorToJson(cleanupError),
                });
            });
        }
    }
}
