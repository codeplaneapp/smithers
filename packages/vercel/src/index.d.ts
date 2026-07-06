import * as _smithers_orchestrator_sandbox from '@smithers-orchestrator/sandbox';

/**
 * A minimal structural type for the `@vercel/sandbox` `Sandbox` class (the parts
 * this provider calls). Injected via `options.client` in tests and advanced
 * setups; otherwise resolved by lazily importing `@vercel/sandbox`.
 */
type VercelSandboxClient$1 = {
    create: (options: Record<string, unknown>) => Promise<VercelSandboxInstance$1>;
};
/**
 * The subset of a live `@vercel/sandbox` `Sandbox` instance this provider uses.
 */
type VercelSandboxInstance$1 = {
    readonly sandboxId?: string;
    writeFiles: (files: Array<{
        path: string;
        content: unknown;
    }>) => Promise<unknown>;
    readFile: (options: {
        path: string;
    }) => Promise<unknown>;
    runCommand: (options: {
        cmd: string;
        args: string[];
        cwd?: string;
        env?: Record<string, string>;
    }) => Promise<VercelFinishedCommand$1>;
    extendTimeout?: (ms: number) => Promise<unknown> | unknown;
    domain?: (port: number) => string;
    stop?: () => Promise<unknown> | unknown;
    delete?: () => Promise<unknown> | unknown;
};
/**
 * The finished command returned by `runCommand`. `stdout()`/`stderr()` are async
 * methods (they resolve the captured streams), `exitCode` is a number.
 */
type VercelFinishedCommand$1 = {
    readonly exitCode?: number;
    stdout: () => Promise<string> | string;
    stderr: () => Promise<string> | string;
};
/**
 * Options for `createVercelSandboxProvider`.
 *
 * Auth precedence: OIDC token (`options.oidcToken` / `VERCEL_OIDC_TOKEN`) is
 * preferred; otherwise an access token trio (`options.token`/`VERCEL_TOKEN` +
 * `options.teamId`/`VERCEL_TEAM_ID` + `options.projectId`/`VERCEL_PROJECT_ID`).
 * Credentials are passed to `Sandbox.create` only and never forwarded into the
 * remote command environment.
 */
type VercelSandboxProviderOptions$1 = {
    /** Override the provider id (defaults to `vercel-sandbox`). */
    id?: string;
    /** In-sandbox entry command. Defaults to the kit default. */
    command?: string;
    /** Remote working directory. Defaults to `/vercel/sandbox`. */
    workdir?: string;
    /** Remote command environment (never receives local credentials). */
    env?: Record<string, string>;
    /** Teardown behavior handled by the kit: `destroy` (default) or `keep`. */
    cleanup?: "destroy" | "keep";
    /** Inject a `Sandbox`-like factory double (tests / advanced users). */
    client?: VercelSandboxClient$1;
    /** Vercel runtime image. Defaults to `node24`. */
    runtime?: string;
    /** Requested vCPUs for the sandbox. */
    vcpus?: number;
    /** Declared ports; each is surfaced as a `sandbox.domain(port)` heartbeat. */
    ports?: number[];
    /**
     * When true, `destroy` stops (pauses) the sandbox instead of deleting it.
     * Default false: ephemeral sandboxes are deleted permanently on teardown.
     */
    persist?: boolean;
    /** Explicit session duration in ms; overrides `request.toolTimeoutMs`. */
    timeoutMs?: number;
    /** Plan duration cap in ms. Default 45 minutes. Exceeding it is an error. */
    maxDurationMs?: number;
    /** OIDC token; overrides `VERCEL_OIDC_TOKEN`. */
    oidcToken?: string;
    /** Access token; overrides `VERCEL_TOKEN`. */
    token?: string;
    /** Team id; overrides `VERCEL_TEAM_ID`. */
    teamId?: string;
    /** Project id; overrides `VERCEL_PROJECT_ID`. */
    projectId?: string;
    /** Extra fields merged into the `Sandbox.create` options. */
    createOptions?: Record<string, unknown>;
};

declare const VERCEL_SANDBOX_PROVIDER_ID: "vercel-sandbox";

/**
 * Build a Smithers SandboxProvider backed by the Vercel Sandbox SDK.
 *
 * The heavy lifting (request shipping, egress, result parsing, secret scrubbing,
 * cleanup) is owned by `createCommandSandboxProvider`; this factory only
 * implements the Vercel-specific `createSession` seam: auth selection, duration
 * mapping with plan-cap enforcement, port domain surfacing, and delete-vs-stop
 * teardown.
 *
 * @param {import("./VercelSandboxProviderOptions.ts").VercelSandboxProviderOptions} [options]
 * @returns {import("@smithers-orchestrator/sandbox").SandboxProvider}
 */
declare function createVercelSandboxProvider(options?: VercelSandboxProviderOptions$1): _smithers_orchestrator_sandbox.SandboxProvider;

/**
 * Construct a Vercel sandbox provider and register it with the sandbox runtime.
 *
 * @param {import("./VercelSandboxProviderOptions.ts").VercelSandboxProviderOptions} [options]
 * @returns {() => void} unregister function
 */
declare function registerVercelSandboxProvider(options?: VercelSandboxProviderOptions$1): () => void;

/**
 * In-memory double for the subset of the `@vercel/sandbox` SDK that
 * `createVercelSandboxProvider` exercises. This is what lets CI run with ZERO
 * Vercel credentials: pass the returned object as `options.client`.
 *
 * The command-execution path parses the shipped request JSON file, invokes the
 * contract `handler`, writes the returned value as JSON to the result file, and
 * returns a finished command whose `stdout()`/`stderr()` are async and whose
 * `exitCode` is 0.
 *
 * @param {(args: {
 *   command: string;
 *   request: Record<string, unknown>;
 *   files: Map<string, string>;
 *   env: Record<string, string>;
 * }) => unknown} handler
 * @param {{
 *   fail?: string | string[];
 *   sandboxIdPrefix?: string;
 *   onDestroy?: () => void;
 * }} [config]
 */
declare function createMockVercelSandboxEnvironment(handler: (args: {
    command: string;
    request: Record<string, unknown>;
    files: Map<string, string>;
    env: Record<string, string>;
}) => unknown, config?: {
    fail?: string | string[];
    sandboxIdPrefix?: string;
    onDestroy?: () => void;
}): {
    create: (createOptions: any) => Promise<{
        sandboxId: string;
        files: Map<string, string>;
        createOptions: any;
        extendTimeoutCalls: any[];
        domainCalls: any[];
        readonly stopped: boolean;
        readonly deleted: boolean;
        readonly destroyed: boolean;
        writeFiles(list: any): Promise<void>;
        readFile({ path }: {
            path: any;
        }): Promise<Buffer<ArrayBuffer>>;
        runCommand({ cmd, args, cwd, env }: {
            cmd: any;
            args: any;
            cwd: any;
            env: any;
        }): Promise<{
            exitCode: number;
            stdout(): Promise<string>;
            stderr(): Promise<string>;
        }>;
        extendTimeout(ms: any): Promise<void>;
        domain(port: any): string;
        stop(): Promise<void>;
        delete(): Promise<void>;
    }>;
    createCalls: any[];
    sandboxes: any[];
};

type VercelSandboxProviderOptions = VercelSandboxProviderOptions$1;
type VercelSandboxClient = VercelSandboxClient$1;
type VercelSandboxInstance = VercelSandboxInstance$1;
type VercelFinishedCommand = VercelFinishedCommand$1;

export { VERCEL_SANDBOX_PROVIDER_ID, type VercelFinishedCommand, type VercelSandboxClient, type VercelSandboxInstance, type VercelSandboxProviderOptions, createMockVercelSandboxEnvironment, createVercelSandboxProvider, registerVercelSandboxProvider };
