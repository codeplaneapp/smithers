export type WorkspaceStatus = {
  cwd: string;
  root: string | null;
  hasSmithers: boolean;
  smithersPath: string | null;
  workflowsPath: string | null;
};

export type WorkspaceBackendRequest = {
  method?: string;
  path: string;
  query?: Record<string, string | null | undefined>;
  body?: unknown;
};

export type WorkspaceBackendResponse<TPayload = unknown> = {
  status: number;
  payload: TPayload;
};
