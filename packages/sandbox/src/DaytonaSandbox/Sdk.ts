/**
 * Defines the injected Daytona SDK slice.
 *
 * @since 0.1.0
 */

interface ExecuteResponse {
  readonly exitCode: number
  readonly result: string
}

interface FileSystem {
  downloadFile(remotePath: string): Promise<Uint8Array>
  uploadFileStream(source: Uint8Array, remotePath: string): Promise<void>
}

interface Process {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>
  ): Promise<ExecuteResponse>
}

interface SandboxInstance {
  readonly id: string
  readonly name: string
  readonly fs: FileSystem
  readonly process: Process
  getWorkDir(): Promise<string | undefined>
}

interface CreateInput {
  readonly name?: string | undefined
}

/**
 * The portion of a configured Daytona client used by this provider.
 *
 * A caller passes an instance created with `new Daytona(...)`. Keeping only
 * this structural slice avoids importing the vendor package or its Node-only
 * transitive dependencies into `@smthrs/sandbox`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sdk {
  get(sandboxIdOrName: string): Promise<SandboxInstance>
  create(params?: CreateInput): Promise<SandboxInstance>
  start(sandbox: SandboxInstance, timeout?: number): Promise<void>
  delete(sandbox: SandboxInstance, timeout?: number, wait?: boolean): Promise<void>
}
