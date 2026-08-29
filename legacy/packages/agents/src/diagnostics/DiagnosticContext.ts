export type DiagnosticContext = {
  env: Record<string, string>;
  cwd: string;
  signal?: AbortSignal;
};
