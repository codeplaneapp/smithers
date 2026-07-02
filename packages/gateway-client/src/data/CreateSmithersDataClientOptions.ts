import type { WorkspaceMode } from "./WorkspaceMode.ts";

export type CreateSmithersDataClientOptions = {
  mode: WorkspaceMode;
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
};
