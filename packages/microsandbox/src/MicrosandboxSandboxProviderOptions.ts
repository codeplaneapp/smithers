import type { SandboxProviderRequest } from "@smithers-orchestrator/sandbox";

export type MicrosandboxExecOptionsBuilderLike = {
  args(args: string[]): MicrosandboxExecOptionsBuilderLike;
  cwd(cwd: string): MicrosandboxExecOptionsBuilderLike;
  envs(vars: Record<string, string>): MicrosandboxExecOptionsBuilderLike;
  timeout(ms: number): MicrosandboxExecOptionsBuilderLike;
};

export type MicrosandboxExecOutputLike = {
  code: number;
  stdout(): string;
  stderr(): string;
};

export type MicrosandboxExecHandleLike = {
  collect(): Promise<MicrosandboxExecOutputLike>;
  kill(): Promise<void>;
};

export type MicrosandboxFsLike = {
  write(path: string, data: string | Uint8Array): Promise<void>;
  readToString(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
};

export type MicrosandboxSandboxLike = {
  readonly name: string;
  fs(): MicrosandboxFsLike;
  execStreamWith(
    cmd: string,
    configure: (builder: MicrosandboxExecOptionsBuilderLike) => MicrosandboxExecOptionsBuilderLike,
  ): Promise<MicrosandboxExecHandleLike>;
  stop(): Promise<void>;
  stopWithTimeout?(timeoutMs: number): Promise<void>;
  detach?(): Promise<void>;
};

export type MicrosandboxSandboxHandleLike = {
  readonly name: string;
  readonly status: "running" | "stopped" | "crashed" | "draining" | string;
  connect(): Promise<MicrosandboxSandboxLike>;
  connectWithTimeout?(timeoutMs: number): Promise<MicrosandboxSandboxLike>;
  start(): Promise<MicrosandboxSandboxLike>;
  startDetached(): Promise<MicrosandboxSandboxLike>;
};

export type MicrosandboxMountBuilderLike = {
  bind(host: string): MicrosandboxMountBuilderLike;
  readonly(): MicrosandboxMountBuilderLike;
};

export type MicrosandboxSandboxBuilderLike = {
  image(source: string): MicrosandboxSandboxBuilderLike;
  fromSnapshot(pathOrName: string): MicrosandboxSandboxBuilderLike;
  cpus(count: number): MicrosandboxSandboxBuilderLike;
  maxCpus(count: number): MicrosandboxSandboxBuilderLike;
  memory(mib: number): MicrosandboxSandboxBuilderLike;
  maxMemory(mib: number): MicrosandboxSandboxBuilderLike;
  workdir(path: string): MicrosandboxSandboxBuilderLike;
  security(profile: "default" | "restricted"): MicrosandboxSandboxBuilderLike;
  pullPolicy(policy: string): MicrosandboxSandboxBuilderLike;
  disableNetwork(): MicrosandboxSandboxBuilderLike;
  port(host: number, guest: number): MicrosandboxSandboxBuilderLike;
  volume(
    guest: string,
    configure: (builder: MicrosandboxMountBuilderLike) => MicrosandboxMountBuilderLike,
  ): MicrosandboxSandboxBuilderLike;
  envs(vars: Record<string, string>): MicrosandboxSandboxBuilderLike;
  labels(labels: Record<string, string>): MicrosandboxSandboxBuilderLike;
  scripts(scripts: Record<string, string>): MicrosandboxSandboxBuilderLike;
  maxDuration(seconds: number): MicrosandboxSandboxBuilderLike;
  idleTimeout(seconds: number): MicrosandboxSandboxBuilderLike;
  ephemeral(enabled: boolean): MicrosandboxSandboxBuilderLike;
  detached(enabled: boolean): MicrosandboxSandboxBuilderLike;
  replace(): MicrosandboxSandboxBuilderLike;
  replaceWithTimeout(timeoutMs: number): MicrosandboxSandboxBuilderLike;
  create(): Promise<MicrosandboxSandboxLike>;
};

export type MicrosandboxSandboxStaticLike = {
  builder(name: string): MicrosandboxSandboxBuilderLike;
  get(name: string): Promise<MicrosandboxSandboxHandleLike>;
  remove(name: string): Promise<void>;
};

export type MicrosandboxSdkLike = {
  Sandbox: MicrosandboxSandboxStaticLike;
};

export type MicrosandboxSetupFile = string | Uint8Array;

export type MicrosandboxSandboxProviderOptions = {
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
  sdk?: MicrosandboxSdkLike;
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
  configureBuilder?: (
    builder: MicrosandboxSandboxBuilderLike,
    request: SandboxProviderRequest,
  ) => MicrosandboxSandboxBuilderLike | void;
};
