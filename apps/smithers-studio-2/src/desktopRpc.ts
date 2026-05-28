import type { WorkspaceBackendRequest, WorkspaceBackendResponse, WorkspaceStatus } from "./workspaceProtocol";

export type StudioRpcSchema = {
  bun: {
    requests: {
      workspaceStatus: {
        params: undefined;
        response: WorkspaceStatus;
      };
      workspaceRequest: {
        params: WorkspaceBackendRequest;
        response: WorkspaceBackendResponse;
      };
    };
    messages: Record<never, never>;
  };
  webview: {
    requests: Record<never, never>;
    messages: Record<never, never>;
  };
};
