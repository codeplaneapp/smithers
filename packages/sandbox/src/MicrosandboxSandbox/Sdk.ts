/**
 * The structural slice of the Microsandbox SDK used by this provider.
 *
 * The SDK is injected by callers so this package remains browser-bundleable
 * and owns no vendor dependency. The private shapes below mirror the vendor's
 * fluent builders, single-drain command handle, lifecycle handles, and guest
 * filesystem operations.
 *
 * @since 0.1.0
 */

interface GuestFs {
  write(path: string, data: Uint8Array | string): Promise<void>
  readToString(path: string): Promise<string>
  mkdir(path: string): Promise<void>
}

interface ExecOutput {
  readonly code: number
  stdout(): string
  stderr(): string
}

interface ExecHandle {
  collect(): Promise<ExecOutput>
}

interface ExecBuilder {
  args(args: Array<string>): this
  cwd(cwd: string): this
  envs(vars: Record<string, string>): this
}

interface Sandbox {
  readonly name: string
  fs(): GuestFs
  execStreamWith(command: string, configure: (builder: ExecBuilder) => ExecBuilder): Promise<ExecHandle>
  stop(): Promise<void>
}

interface SandboxHandle {
  readonly status: string
  connect(): Promise<Sandbox>
  start(): Promise<Sandbox>
  startDetached(): Promise<Sandbox>
}

interface SandboxBuilder {
  image(image: string): this
  fromSnapshot(pathOrName: string): this
  cpus(count: number): this
  maxCpus(count: number): this
  memory(mib: number): this
  maxMemory(mib: number): this
  security(profile: "default" | "restricted"): this
  pullPolicy(policy: string): this
  labels(labels: Record<string, string>): this
  scripts(scripts: Record<string, string>): this
  maxDuration(seconds: number): this
  idleTimeout(seconds: number): this
  ephemeral(enabled: boolean): this
  detached(enabled: boolean): this
  disableNetwork(): this
  create(): Promise<Sandbox>
}

/**
 * The Microsandbox SDK entry point required by the provider.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sdk {
  readonly Sandbox: {
    builder(name: string): SandboxBuilder
    get(name: string): Promise<SandboxHandle>
  }
}
