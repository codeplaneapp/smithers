export type GitHubListenerEvent =
  | "issues"
  | "issue_comment"
  | "pull_request"
  | "pull_request_review"
  | "pull_request_review_comment";

export type GitHubListener = {
  id: string;
  provider: "github";
  repository: string;
  events: GitHubListenerEvent[];
  workflow: string;
  callbackUrl: string;
  secretEnv: string;
  active: boolean;
};

export type ListenerRegistry = {
  version: 1;
  listeners: GitHubListener[];
};

export type GitHubListenerOwnership = {
  listenerId: string;
  repository: string;
  hookId: number;
  callbackUrl: string;
  secretDigest?: string;
};

export type ListenerOwnershipState = {
  version: 1;
  github: GitHubListenerOwnership[];
};

export type GitHubRemoteHook = {
  id: number;
  active: boolean;
  events: string[];
  config: {
    url?: string;
    content_type?: string;
    insecure_ssl?: string | number;
  };
};

export type ListenerPlanAction = {
  action: "create" | "update" | "delete" | "noop" | "leave" | "conflict";
  listenerId: string | null;
  repository: string;
  hookId: number | null;
  reason: string;
  destructive: boolean;
};

export type ListenerReconcilePlan = {
  registryPath: string;
  statePath: string;
  actions: ListenerPlanAction[];
  changes: number;
  destructiveChanges: number;
};

export type ReconcileGitHubListenersOptions = {
  workspaceRoot?: string;
  registry?: ListenerRegistry;
  apply?: boolean;
  allowDelete?: boolean;
  token?: string;
  apiBaseUrl?: string;
  env?: Record<string, string | undefined>;
};
