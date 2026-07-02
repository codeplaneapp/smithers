export type HelloResponse = {
  protocol: number;
  features: string[];
  /**
   * Which workspace/process answered, so clients can verify they reached the
   * gateway they resolved locally (see also `GET /health`).
   */
  identity: {
    workspaceRoot: string | null;
    backend: string | null;
    version: string | null;
    pid: number;
    startedAtMs: number;
  };
  policy: {
    heartbeatMs: number;
  };
  auth: {
    sessionToken: string;
    role: string;
    scopes: string[];
    userId: string | null;
  };
  snapshot: {
    runs: unknown[];
    approvals: unknown[];
    stateVersion: number;
  };
};
