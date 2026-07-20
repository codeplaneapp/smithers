export type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when captured stdout exceeded maxOutputBytes and was truncated. */
  stdoutTruncated?: boolean;
  /** True when captured stderr exceeded maxOutputBytes and was truncated. */
  stderrTruncated?: boolean;
};
