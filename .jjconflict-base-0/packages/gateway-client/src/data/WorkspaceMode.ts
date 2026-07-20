export type WorkspaceMode =
  | { kind: "local"; apiBaseUrl: string; token?: string }
  | { kind: "multiplayer"; apiBaseUrl: string; electricBaseUrl: string; workspaceId: string; token?: string };
