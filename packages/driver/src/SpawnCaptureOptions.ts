export type SpawnCaptureOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * Which end of overflowing STDOUT to keep. CLI agents that emit their final
   * result at the end of an NDJSON stream should keep the tail. Stderr always
   * keeps the head: failure classification reads the leading error text.
   * @default "head"
   */
  truncateKeep?: "head" | "tail";
  detached?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /**
   * Process lifecycle notifications. `exited` fires on the OS-level exit of
   * the spawned process, which can precede the capture promise settling: a
   * grandchild that inherited the stdio pipes keeps `close` pending long after
   * the worker itself is gone. `exitCode`/`signal` describe how it died.
   */
  onProcess?: (event: {
    phase: "started" | "exited";
    pid: number | undefined;
    exitCode?: number | null;
    signal?: string | null;
  }) => void;
};
