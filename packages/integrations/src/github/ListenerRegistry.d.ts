import { GitHubListener as GitHubListener$1, GitHubRemoteHook as GitHubRemoteHook$1, ListenerOwnershipState as ListenerOwnershipState$1, ListenerPlanAction as ListenerPlanAction$1, ListenerReconcilePlan as ListenerReconcilePlan$1, ListenerRegistry as ListenerRegistry$1, ReconcileGitHubListenersOptions as ReconcileGitHubListenersOptions$1 } from './ListenerRegistryTypes.js';
import { z } from 'zod';

/** @param {unknown} input @param {string} [source] @returns {ListenerRegistry} */
declare function parseListenerRegistry(input: unknown, source?: string): ListenerRegistry;
/** @param {string} [workspaceRoot] @returns {ListenerRegistry} */
declare function readListenerRegistry(workspaceRoot?: string): ListenerRegistry;
/** @param {string} workspaceRoot @returns {ListenerOwnershipState} */
declare function readListenerOwnershipState(workspaceRoot: string): ListenerOwnershipState;
/**
 * Pure desired-vs-remote planner. A hook is owned only when its numeric GitHub
 * hook id is present in the local ownership state. Matching URLs are not proof
 * of ownership.
 * @param {{ registry: ListenerRegistry; state: ListenerOwnershipState; hooksByRepository: Map<string, GitHubRemoteHook[]> | Record<string, GitHubRemoteHook[]>; secretDigests?: Map<string, string> }} input
 * @returns {ListenerPlanAction[]}
 */
declare function planGitHubListenerReconciliation(input: {
    registry: ListenerRegistry;
    state: ListenerOwnershipState;
    hooksByRepository: Map<string, GitHubRemoteHook[]> | Record<string, GitHubRemoteHook[]>;
    secretDigests?: Map<string, string>;
}): ListenerPlanAction[];
/**
 * Compute a plan by default. `apply: true` explicitly enables creates and
 * updates; deletes additionally require `allowDelete: true`.
 * @param {ReconcileGitHubListenersOptions} [options]
 * @returns {Promise<ListenerReconcilePlan & { applied: ListenerPlanAction[]; skipped: ListenerPlanAction[] }>}
 */
declare function reconcileGitHubListeners(options?: ReconcileGitHubListenersOptions): Promise<ListenerReconcilePlan & {
    applied: ListenerPlanAction[];
    skipped: ListenerPlanAction[];
}>;
declare const DEFAULT_LISTENER_REGISTRY_PATH: ".smithers/listeners.json";
declare const DEFAULT_LISTENER_STATE_PATH: ".smithers/listeners.state.json";
declare const listenerRegistrySchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    listeners: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        provider: z.ZodLiteral<"github">;
        repository: z.ZodString;
        events: z.ZodArray<z.ZodEnum<{
            issues: "issues";
            issue_comment: "issue_comment";
            pull_request: "pull_request";
            pull_request_review: "pull_request_review";
            pull_request_review_comment: "pull_request_review_comment";
        }>>;
        workflow: z.ZodString;
        callbackUrl: z.ZodURL;
        secretEnv: z.ZodString;
        active: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
type GitHubListener = GitHubListener$1;
type GitHubRemoteHook = GitHubRemoteHook$1;
type ListenerOwnershipState = ListenerOwnershipState$1;
type ListenerPlanAction = ListenerPlanAction$1;
type ListenerReconcilePlan = ListenerReconcilePlan$1;
type ListenerRegistry = ListenerRegistry$1;
type ReconcileGitHubListenersOptions = ReconcileGitHubListenersOptions$1;

export { DEFAULT_LISTENER_REGISTRY_PATH, DEFAULT_LISTENER_STATE_PATH, type GitHubListener, type GitHubRemoteHook, type ListenerOwnershipState, type ListenerPlanAction, type ListenerReconcilePlan, type ListenerRegistry, type ReconcileGitHubListenersOptions, listenerRegistrySchema, parseListenerRegistry, planGitHubListenerReconciliation, readListenerOwnershipState, readListenerRegistry, reconcileGitHubListeners };
