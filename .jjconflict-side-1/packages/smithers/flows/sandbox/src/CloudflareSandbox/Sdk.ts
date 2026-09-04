/**
 * The structural slice of `@cloudflare/sandbox` used by this provider.
 *
 * @since 0.1.0
 */

interface CommandOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
}

interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

interface ProcessLogs {
  readonly stdout: string
  readonly stderr: string
}

interface Process {
  readonly exitCode?: number | undefined
  waitForExit(timeout?: number): Promise<{ readonly exitCode?: number | undefined }>
  getLogs(): Promise<ProcessLogs>
}

interface ReadFileResult {
  readonly content: string
}

interface SandboxOptions {
  readonly enableDefaultSession?: boolean | undefined
  readonly keepAlive?: boolean | undefined
  readonly sleepAfter?: string | number | undefined
}

interface Sandbox {
  mkdir(path: string, options?: { readonly recursive?: boolean | undefined }): Promise<unknown>
  writeFile(path: string, content: string, options?: { readonly encoding?: string | undefined }): Promise<unknown>
  readFile(path: string, options?: { readonly encoding?: "base64" | undefined }): Promise<ReadFileResult>
  exec(command: string, options?: CommandOptions): Promise<ExecResult>
  startProcess(command: string, options?: CommandOptions): Promise<Process>
  destroy(): Promise<void>
}

/**
 * The caller-supplied Cloudflare Sandbox SDK module.
 *
 * Keeping this structural avoids importing a Worker-only package into the
 * browser-gated sandbox package. The binding remains generic because its real
 * `DurableObjectNamespace` type only exists in a Worker environment.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sdk<Binding = unknown> {
  readonly getSandbox: (binding: Binding, id: string, options?: SandboxOptions) => Sandbox
}
