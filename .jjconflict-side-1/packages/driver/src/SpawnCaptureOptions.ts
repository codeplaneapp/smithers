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
  onProcess?: (event: { phase: "started" | "exited"; pid: number | undefined }) => void;
};
