type GitHubListenerEvent = "issues" | "issue_comment" | "pull_request" | "pull_request_review" | "pull_request_review_comment";
type GitHubListener = {
    id: string;
    provider: "github";
    repository: string;
    events: GitHubListenerEvent[];
    workflow: string;
    callbackUrl: string;
    secretEnv: string;
    active: boolean;
};
type ListenerRegistry = {
    version: 1;
    listeners: GitHubListener[];
};
type GitHubListenerOwnership = {
    listenerId: string;
    repository: string;
    hookId: number;
    callbackUrl: string;
    secretDigest?: string;
};
type ListenerOwnershipState = {
    version: 1;
    github: GitHubListenerOwnership[];
};
type GitHubRemoteHook = {
    id: number;
    active: boolean;
    events: string[];
    config: {
        url?: string;
        content_type?: string;
        insecure_ssl?: string | number;
    };
};
type ListenerPlanAction = {
    action: "create" | "update" | "delete" | "noop" | "leave" | "conflict";
    listenerId: string | null;
    repository: string;
    hookId: number | null;
    reason: string;
    destructive: boolean;
};
type ListenerReconcilePlan = {
    registryPath: string;
    statePath: string;
    actions: ListenerPlanAction[];
    changes: number;
    destructiveChanges: number;
};
type ReconcileGitHubListenersOptions = {
    workspaceRoot?: string;
    registry?: ListenerRegistry;
    apply?: boolean;
    allowDelete?: boolean;
    token?: string;
    apiBaseUrl?: string;
    /**
     * Replaces the ambient environment outright (not layered over it) for both
     * webhook secrets and GitHub credentials, so an ambient `GITHUB_TOKEN`
     * cannot decide which account a repository's webhooks are created under.
     */
    env?: Record<string, string | undefined>;
};

export type { GitHubListener, GitHubListenerEvent, GitHubListenerOwnership, GitHubRemoteHook, ListenerOwnershipState, ListenerPlanAction, ListenerReconcilePlan, ListenerRegistry, ReconcileGitHubListenersOptions };
