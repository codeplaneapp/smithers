/**
 * Defines the injected Vercel Sandbox SDK slice.
 *
 * @since 0.1.0
 */

type ReadableFile = AsyncIterable<string | Uint8Array>

interface CommandFinished {
  readonly exitCode: number
  stdout(): Promise<string>
  stderr(): Promise<string>
}

interface SandboxInstance {
  readonly name: string
  runCommand(params: {
    readonly cmd: string
    readonly args?: Array<string> | undefined
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string>> | undefined
  }): Promise<CommandFinished>
  readFile(file: { readonly path: string }): Promise<ReadableFile | null>
  writeFiles(files: Array<{ readonly path: string; readonly content: Uint8Array | string }>): Promise<void>
  extendTimeout(duration: number): Promise<unknown>
  stop(): Promise<unknown>
}

type GetOrCreateInput = {
  readonly name: string
  readonly timeout?: number | undefined
  readonly runtime?: string | undefined
  readonly persistent?: boolean | undefined
  readonly resume?: boolean | undefined
  readonly token?: string | undefined
  readonly teamId?: string | undefined
  readonly projectId?: string | undefined
}

/**
 * The portion of `@vercel/sandbox` used by this provider.
 *
 * The SDK is injected rather than imported, keeping the package free of a
 * vendor dependency and preserving its browser bundle contract.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sdk {
  readonly Sandbox: {
    getOrCreate(input: GetOrCreateInput): Promise<SandboxInstance>
  }
}
