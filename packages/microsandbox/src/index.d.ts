import * as _smithers_orchestrator_sandbox from '@smthrs/sandbox';
import { SandboxProviderRequest } from '@smthrs/sandbox';

type MicrosandboxExecOptionsBuilderLike = {
    args(args: string[]): MicrosandboxExecOptionsBuilderLike;
    cwd(cwd: string): MicrosandboxExecOptionsBuilderLike;
    envs(vars: Record<string, string>): MicrosandboxExecOptionsBuilderLike;
    timeout(ms: number): MicrosandboxExecOptionsBuilderLike;
};
type MicrosandboxExecOutputLike = {
    code: number;
    stdout(): string;
    stderr(): string;
};
type MicrosandboxExecHandleLike = {
    collect(): Promise<MicrosandboxExecOutputLike>;
    kill(): Promise<void>;
};
type MicrosandboxFsLike = {
    write(path: string, data: string | Uint8Array): Promise<void>;
    readToString(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
};
type MicrosandboxSandboxLike$1 = {
    readonly name: string;
    fs(): MicrosandboxFsLike;
    execStreamWith(cmd: string, configure: (builder: MicrosandboxExecOptionsBuilderLike) => MicrosandboxExecOptionsBuilderLike): Promise<MicrosandboxExecHandleLike>;
    stop(): Promise<void>;
    stopWithTimeout?(timeoutMs: number): Promise<void>;
    detach?(): Promise<void>;
};
type MicrosandboxSandboxHandleLike$1 = {
    readonly name: string;
    readonly status: "running" | "stopped" | "crashed" | "draining" | string;
    connect(): Promise<MicrosandboxSandboxLike$1>;
    connectWithTimeout?(timeoutMs: number): Promise<MicrosandboxSandboxLike$1>;
    start(): Promise<MicrosandboxSandboxLike$1>;
    startDetached(): Promise<MicrosandboxSandboxLike$1>;
};
type MicrosandboxMountBuilderLike = {
    bind(host: string): MicrosandboxMountBuilderLike;
    readonly(): MicrosandboxMountBuilderLike;
};
type MicrosandboxSandboxBuilderLike$1 = {
    image(source: string): MicrosandboxSandboxBuilderLike$1;
    fromSnapshot(pathOrName: string): MicrosandboxSandboxBuilderLike$1;
    cpus(count: number): MicrosandboxSandboxBuilderLike$1;
    maxCpus(count: number): MicrosandboxSandboxBuilderLike$1;
    memory(mib: number): MicrosandboxSandboxBuilderLike$1;
    maxMemory(mib: number): MicrosandboxSandboxBuilderLike$1;
    workdir(path: string): MicrosandboxSandboxBuilderLike$1;
    security(profile: "default" | "restricted"): MicrosandboxSandboxBuilderLike$1;
    pullPolicy(policy: string): MicrosandboxSandboxBuilderLike$1;
    disableNetwork(): MicrosandboxSandboxBuilderLike$1;
    port(host: number, guest: number): MicrosandboxSandboxBuilderLike$1;
    volume(guest: string, configure: (builder: MicrosandboxMountBuilderLike) => MicrosandboxMountBuilderLike): MicrosandboxSandboxBuilderLike$1;
    envs(vars: Record<string, string>): MicrosandboxSandboxBuilderLike$1;
    labels(labels: Record<string, string>): MicrosandboxSandboxBuilderLike$1;
    scripts(scripts: Record<string, string>): MicrosandboxSandboxBuilderLike$1;
    maxDuration(seconds: number): MicrosandboxSandboxBuilderLike$1;
    idleTimeout(seconds: number): MicrosandboxSandboxBuilderLike$1;
    ephemeral(enabled: boolean): MicrosandboxSandboxBuilderLike$1;
    detached(enabled: boolean): MicrosandboxSandboxBuilderLike$1;
    replace(): MicrosandboxSandboxBuilderLike$1;
    replaceWithTimeout(timeoutMs: number): MicrosandboxSandboxBuilderLike$1;
    create(): Promise<MicrosandboxSandboxLike$1>;
};
type MicrosandboxSandboxStaticLike$1 = {
    builder(name: string): MicrosandboxSandboxBuilderLike$1;
    get(name: string): Promise<MicrosandboxSandboxHandleLike$1>;
    remove(name: string): Promise<void>;
};
type MicrosandboxSdkLike$1 = {
    Sandbox: MicrosandboxSandboxStaticLike$1;
};
type MicrosandboxSetupFile = string | Uint8Array;
type MicrosandboxSandboxProviderOptions$1 = {
    /** Provider id. Defaults to `microsandbox`. */
    id?: string;
    /** Entry command. Wins over `<Sandbox command>` and defaults to the bundled-runner path. */
    command?: string;
    /** Guest working directory created after boot and used for Smithers I/O. Defaults to `/workspace`. */
    workdir?: string;
    /** Extra per-command env. Never copies arbitrary host env. */
    env?: Record<string, string>;
    /** Whether cleanup destroys/stops the sandbox or leaves it running. */
    cleanup?: "destroy" | "keep";
    /** Guest shell used to run the command. Defaults to `/bin/sh`. */
    shell?: string;
    /** Inject the Microsandbox SDK surface (tests or advanced embedding). */
    sdk?: MicrosandboxSdkLike$1;
    /** Injectable SDK importer used by tests. Production imports `microsandbox`. */
    importSdk?: () => Promise<unknown>;
    /** Default OCI image/rootfs. Defaults to `oven/bun:1`. */
    image?: string;
    /** Default snapshot. Mutually exclusive with `image`. */
    snapshot?: string;
    /** Explicit name or request-to-name function. Defaults to a derived Smithers name. */
    sandboxName?: string | ((request: SandboxProviderRequest) => string);
    /** Initial vCPU count. */
    cpus?: number;
    /** Resize headroom for vCPUs. */
    maxCpus?: number;
    /** Initial memory in MiB. */
    memoryMib?: number;
    /** Resize headroom for memory in MiB. */
    maxMemoryMib?: number;
    /** In-guest security profile. */
    security?: "default" | "restricted";
    /** Microsandbox image pull policy. */
    pullPolicy?: string;
    /** Microsandbox labels. */
    labels?: Record<string, string>;
    /** Scripts mounted at `/.msb/scripts` and placed on PATH. */
    scripts?: Record<string, string>;
    /** Files uploaded after boot and before Smithers writes its request. */
    setupFiles?: Record<string, MicrosandboxSetupFile>;
    /** Host-enforced maximum sandbox lifetime. */
    maxDurationSecs?: number;
    /** Host-enforced idle timeout. */
    idleTimeoutSecs?: number;
    /** Override Microsandbox's ephemeral flag. Sticky workspaces always disable it. */
    ephemeral?: boolean;
    /** Override attached/detached creation. `cleanup:"keep"` defaults to detached. */
    detached?: boolean;
    /** Replace a conflicting non-sticky sandbox name. Defaults to `true`. */
    replaceExisting?: boolean;
    /** Grace period used by replace before force-kill. */
    replaceTimeoutMs?: number;
    /** Grace period used by cleanup before force-kill. */
    stopTimeoutMs?: number;
    /** Provisioning timeout. Defaults to the Smithers tool timeout. */
    creationTimeoutMs?: number;
    /** Apply vendor-specific builder configuration after standard Smithers mappings. */
    configureBuilder?: (builder: MicrosandboxSandboxBuilderLike$1, request: SandboxProviderRequest) => MicrosandboxSandboxBuilderLike$1 | void;
};

declare const MICROSANDBOX_PROVIDER_ID: "microsandbox";

/**
 * Build a Smithers SandboxProvider backed by local Microsandbox microVMs.
 *
 * The shared provider-kit owns request/result serialization, egress env,
 * result parsing, and provider cleanup. This factory maps its SandboxSession
 * seam onto the Microsandbox TypeScript SDK.
 *
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSandboxProviderOptions} [options]
 * @returns {import("@smthrs/sandbox").SandboxProvider}
 */
declare function createMicrosandboxSandboxProvider(options?: MicrosandboxSandboxProviderOptions$1): _smithers_orchestrator_sandbox.SandboxProvider;

/**
 * Build and register a Microsandbox provider in Smithers' global registry.
 *
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSandboxProviderOptions} [options]
 * @returns {() => void}
 */
declare function registerMicrosandboxSandboxProvider(options?: MicrosandboxSandboxProviderOptions$1): () => void;

type MicrosandboxSandboxProviderOptions = MicrosandboxSandboxProviderOptions$1;
type MicrosandboxSdkLike = MicrosandboxSdkLike$1;
type MicrosandboxSandboxStaticLike = MicrosandboxSandboxStaticLike$1;
type MicrosandboxSandboxBuilderLike = MicrosandboxSandboxBuilderLike$1;
type MicrosandboxSandboxHandleLike = MicrosandboxSandboxHandleLike$1;
type MicrosandboxSandboxLike = MicrosandboxSandboxLike$1;

export { MICROSANDBOX_PROVIDER_ID, type MicrosandboxSandboxBuilderLike, type MicrosandboxSandboxHandleLike, type MicrosandboxSandboxLike, type MicrosandboxSandboxProviderOptions, type MicrosandboxSandboxStaticLike, type MicrosandboxSdkLike, createMicrosandboxSandboxProvider, registerMicrosandboxSandboxProvider };
