export type SandboxExecOptions = { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal };
export type SandboxExecResult = { exitCode: number; stdout: string; stderr: string };
export type SandboxSession = {
  readonly remoteId: string;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly exec: (command: string, opts: SandboxExecOptions) => Promise<SandboxExecResult>;
  readonly destroy?: () => Promise<void>;
};
