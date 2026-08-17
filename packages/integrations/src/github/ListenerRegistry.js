// @smithers-type-exports-begin
/** @typedef {import("./ListenerRegistryTypes.ts").GitHubListener} GitHubListener */
/** @typedef {import("./ListenerRegistryTypes.ts").GitHubRemoteHook} GitHubRemoteHook */
/** @typedef {import("./ListenerRegistryTypes.ts").ListenerOwnershipState} ListenerOwnershipState */
/** @typedef {import("./ListenerRegistryTypes.ts").ListenerPlanAction} ListenerPlanAction */
/** @typedef {import("./ListenerRegistryTypes.ts").ListenerReconcilePlan} ListenerReconcilePlan */
/** @typedef {import("./ListenerRegistryTypes.ts").ListenerRegistry} ListenerRegistry */
/** @typedef {import("./ListenerRegistryTypes.ts").ReconcileGitHubListenersOptions} ReconcileGitHubListenersOptions */
// @smithers-type-exports-end

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { IntegrationError } from "../core/IntegrationError.js";
import { makeGitHubClient } from "./GitHubClient.js";
import { resolveGitHubConfig } from "./config.js";

export const DEFAULT_LISTENER_REGISTRY_PATH = ".smithers/listeners.json";
export const DEFAULT_LISTENER_STATE_PATH = ".smithers/listeners.state.json";

const githubEventSchema = z.enum([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
]);

const listenerSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "must use lowercase letters, numbers, dots, underscores, or hyphens"),
    provider: z.literal("github"),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/repository"),
    events: z.array(githubEventSchema).min(1),
    workflow: z.string().min(1),
    callbackUrl: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    }, "must be an HTTPS URL without embedded credentials, query parameters, or a fragment"),
    secretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name"),
    active: z.boolean().default(true),
  })
  .strict();

export const listenerRegistrySchema = z
  .object({
    version: z.literal(1),
    listeners: z.array(listenerSchema),
  })
  .strict()
  .superRefine((registry, context) => {
    const ids = new Set();
    const destinations = new Map();
    for (let index = 0; index < registry.listeners.length; index += 1) {
      const listener = registry.listeners[index];
      if (ids.has(listener.id)) {
        context.addIssue({
          code: "custom",
          path: ["listeners", index, "id"],
          message: `duplicate listener id "${listener.id}"`,
        });
      }
      ids.add(listener.id);
      const route = new URL(listener.callbackUrl).pathname.replace(/\/+$/, "");
      if (route !== `/webhooks/${encodeURIComponent(listener.workflow)}`) {
        context.addIssue({
          code: "custom",
          path: ["listeners", index, "callbackUrl"],
          message: `path must be /webhooks/${encodeURIComponent(listener.workflow)} for workflow "${listener.workflow}"`,
        });
      }
      const existing = destinations.get(listener.workflow);
      const destination = `${listener.callbackUrl}\u0000${listener.secretEnv}`;
      if (existing && existing !== destination) {
        context.addIssue({
          code: "custom",
          path: ["listeners", index],
          message: `listeners for workflow "${listener.workflow}" must share callbackUrl and secretEnv`,
        });
      }
      destinations.set(listener.workflow, destination);
    }
  });

const ownershipStateSchema = z
  .object({
    version: z.literal(1),
    github: z.array(
      z
        .object({
          listenerId: z.string(),
          repository: z.string(),
          hookId: z.number().int().positive(),
          callbackUrl: z.string(),
          secretDigest: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

function invalidConfig(message, details, cause) {
  return new IntegrationError("invalid-config", message, details, cause ? { cause } : undefined);
}

/** @param {unknown} input @param {string} [source] @returns {ListenerRegistry} */
export function parseListenerRegistry(input, source = DEFAULT_LISTENER_REGISTRY_PATH) {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (cause) {
      throw invalidConfig(`Listener registry ${source} is not valid JSON.`, { source }, cause);
    }
  }
  const result = listenerRegistrySchema.safeParse(value);
  if (!result.success) {
    throw invalidConfig(`Listener registry ${source} failed validation:\n${z.prettifyError(result.error)}`, { source });
  }
  return result.data;
}

/** @param {string} [workspaceRoot] @returns {ListenerRegistry} */
export function readListenerRegistry(workspaceRoot = process.cwd()) {
  const path = resolve(workspaceRoot, DEFAULT_LISTENER_REGISTRY_PATH);
  if (!existsSync(path)) {
    throw invalidConfig(`Listener registry not found at ${path}.`, { path });
  }
  return parseListenerRegistry(readFileSync(path, "utf8"), path);
}

/** @param {string} workspaceRoot @returns {ListenerOwnershipState} */
export function readListenerOwnershipState(workspaceRoot) {
  const path = resolve(workspaceRoot, DEFAULT_LISTENER_STATE_PATH);
  if (!existsSync(path)) return { version: 1, github: [] };
  try {
    return ownershipStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (cause) {
    throw invalidConfig(
      `Listener ownership state ${path} is invalid; refusing unsafe reconciliation.`,
      { path },
      cause,
    );
  }
}

/** @param {string} workspaceRoot @param {ListenerOwnershipState} state */
function writeListenerOwnershipState(workspaceRoot, state) {
  const path = resolve(workspaceRoot, DEFAULT_LISTENER_STATE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

const normalizedEvents = (events) => [...new Set(events)].sort();
const sameEvents = (left, right) => JSON.stringify(normalizedEvents(left)) === JSON.stringify(normalizedEvents(right));
const secretDigest = (secret) => createHash("sha256").update(secret).digest("hex");

/**
 * Pure desired-vs-remote planner. A hook is owned only when its numeric GitHub
 * hook id is present in the local ownership state. Matching URLs are not proof
 * of ownership.
 * @param {{ registry: ListenerRegistry; state: ListenerOwnershipState; hooksByRepository: Map<string, GitHubRemoteHook[]> | Record<string, GitHubRemoteHook[]>; secretDigests?: Map<string, string> }} input
 * @returns {ListenerPlanAction[]}
 */
export function planGitHubListenerReconciliation(input) {
  const hooksFor = (repository) =>
    input.hooksByRepository instanceof Map
      ? (input.hooksByRepository.get(repository) ?? [])
      : (input.hooksByRepository[repository] ?? []);
  const desiredById = new Map(input.registry.listeners.map((listener) => [listener.id, listener]));
  const ownershipById = new Map(input.state.github.map((owned) => [owned.listenerId, owned]));
  /** @type {ListenerPlanAction[]} */
  const actions = [];
  const ownedHookKeys = new Set(input.state.github.map((owned) => `${owned.repository}:${owned.hookId}`));
  for (const listener of input.registry.listeners) {
    const owned = ownershipById.get(listener.id);
    const hooks = hooksFor(listener.repository);
    const remote = owned ? hooks.find((hook) => hook.id === owned.hookId) : undefined;
    if (!owned) {
      const collision = hooks.find((hook) => hook.config?.url === listener.callbackUrl);
      actions.push({
        action: collision ? "conflict" : "create",
        listenerId: listener.id,
        repository: listener.repository,
        hookId: collision?.id ?? null,
        reason: collision ? "matching callback URL is not owned by this workspace" : "declared listener is missing",
        destructive: false,
      });
      continue;
    }
    if (owned.repository !== listener.repository) {
      actions.push({
        action: "delete",
        listenerId: listener.id,
        repository: owned.repository,
        hookId: owned.hookId,
        reason: "owned listener moved repositories",
        destructive: true,
      });
      actions.push({
        action: "create",
        listenerId: listener.id,
        repository: listener.repository,
        hookId: null,
        reason: "declared listener moved repositories",
        destructive: false,
      });
      continue;
    }
    if (!remote) {
      actions.push({
        action: "create",
        listenerId: listener.id,
        repository: listener.repository,
        hookId: null,
        reason: "owned GitHub hook was removed remotely",
        destructive: false,
      });
      continue;
    }
    const drifted =
      remote.config?.url !== listener.callbackUrl ||
      remote.config?.content_type !== "json" ||
      String(remote.config?.insecure_ssl ?? "0") !== "0" ||
      remote.active !== listener.active ||
      !sameEvents(remote.events, listener.events) ||
      (input.secretDigests?.get(listener.id) !== undefined &&
        owned.secretDigest !== input.secretDigests.get(listener.id));
    actions.push({
      action: drifted ? "update" : "noop",
      listenerId: listener.id,
      repository: listener.repository,
      hookId: remote.id,
      reason: drifted ? "owned GitHub hook drifted from the declaration" : "owned GitHub hook matches the declaration",
      destructive: false,
    });
  }
  for (const owned of input.state.github) {
    if (!desiredById.has(owned.listenerId)) {
      const exists = hooksFor(owned.repository).some((hook) => hook.id === owned.hookId);
      if (exists)
        actions.push({
          action: "delete",
          listenerId: owned.listenerId,
          repository: owned.repository,
          hookId: owned.hookId,
          reason: "owned listener was removed from the registry",
          destructive: true,
        });
    }
  }
  for (const listener of input.registry.listeners) {
    for (const hook of hooksFor(listener.repository)) {
      const key = `${listener.repository}:${hook.id}`;
      if (!ownedHookKeys.has(key) && hook.config?.url !== listener.callbackUrl) {
        actions.push({
          action: "leave",
          listenerId: null,
          repository: listener.repository,
          hookId: hook.id,
          reason: "GitHub hook is not owned by this workspace",
          destructive: false,
        });
      }
    }
  }
  return actions;
}

const splitRepository = (repository) => repository.split("/").map(encodeURIComponent).join("/");

function permissionError(repository, cause) {
  const status = cause?.details?.status;
  if (status === 401 || status === 403 || status === 404) {
    return new IntegrationError(
      "permission-denied",
      `GitHub listener reconciliation cannot administer webhooks for ${repository}. The token needs fine-grained Webhooks read/write permission or classic admin:repo_hook access.`,
      { repository, status },
      { cause },
    );
  }
  return cause;
}

/**
 * Compute a plan by default. `apply: true` explicitly enables creates and
 * updates; deletes additionally require `allowDelete: true`.
 * @param {ReconcileGitHubListenersOptions} [options]
 * @returns {Promise<ListenerReconcilePlan & { applied: ListenerPlanAction[]; skipped: ListenerPlanAction[] }>}
 */
export async function reconcileGitHubListeners(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const registryPath = resolve(workspaceRoot, DEFAULT_LISTENER_REGISTRY_PATH);
  const statePath = resolve(workspaceRoot, DEFAULT_LISTENER_STATE_PATH);
  const registry = options.registry ?? readListenerRegistry(workspaceRoot);
  const state = readListenerOwnershipState(workspaceRoot);
  const resolved = resolveGitHubConfig({ token: options.token, apiBaseUrl: options.apiBaseUrl });
  if (!resolved.token) {
    throw new IntegrationError(
      "credentials-missing",
      "GitHub listener reconciliation requires SMITHERS_GITHUB_TOKEN (or GITHUB_TOKEN) with fine-grained Webhooks read/write permission or classic admin:repo_hook access.",
    );
  }
  const env = options.env ?? process.env;
  const secrets = new Map();
  const digests = new Map();
  for (const listener of registry.listeners) {
    const secret = env[listener.secretEnv];
    if (!secret) {
      throw new IntegrationError(
        "credentials-missing",
        `GitHub listener "${listener.id}" requires webhook secret environment variable ${listener.secretEnv}.`,
        { listenerId: listener.id, secretEnv: listener.secretEnv },
      );
    }
    secrets.set(listener.id, secret);
    digests.set(listener.id, secretDigest(secret));
  }
  const repositories = new Set([
    ...registry.listeners.map((listener) => listener.repository),
    ...state.github.map((owned) => owned.repository),
  ]);
  const client = makeGitHubClient({ token: resolved.token, apiBaseUrl: resolved.apiBaseUrl });
  const hooksByRepository = new Map();
  for (const repository of repositories) {
    try {
      const hooks = await Effect.runPromise(
        client.paginate(`/repos/${splitRepository(repository)}/hooks`, { maxPages: 10 }),
      );
      hooksByRepository.set(repository, /** @type {GitHubRemoteHook[]} */ (hooks));
    } catch (cause) {
      throw permissionError(repository, cause);
    }
  }
  const actions = planGitHubListenerReconciliation({ registry, state, hooksByRepository, secretDigests: digests });
  const plan = {
    registryPath,
    statePath,
    actions,
    changes: actions.filter((action) => ["create", "update", "delete"].includes(action.action)).length,
    destructiveChanges: actions.filter((action) => action.action === "delete").length,
  };
  /** @type {ListenerPlanAction[]} */
  const applied = [];
  /** @type {ListenerPlanAction[]} */
  const skipped = [];
  if (!options.apply)
    return {
      ...plan,
      applied,
      skipped: actions.filter((action) => action.action !== "noop" && action.action !== "leave"),
    };
  if (actions.some((action) => action.action === "conflict")) {
    throw new IntegrationError(
      "listener-conflict",
      "GitHub listener apply refused because an unowned hook uses a declared callback URL. Adopt it manually or choose a different callback URL; Smithers will not modify it.",
      { conflicts: actions.filter((action) => action.action === "conflict") },
    );
  }
  /** @type {ListenerOwnershipState} */
  const nextState = { version: 1, github: state.github.map((owned) => ({ ...owned })) };
  const desiredById = new Map(registry.listeners.map((listener) => [listener.id, listener]));
  const movesBlockedByDeleteSafety = new Set(
    options.allowDelete
      ? []
      : actions
          .filter((action) => action.action === "delete" && action.listenerId && desiredById.has(action.listenerId))
          .map((action) => action.listenerId),
  );
  for (const action of actions) {
    if (action.action === "delete" && !options.allowDelete) {
      skipped.push(action);
      continue;
    }
    if (!["create", "update", "delete"].includes(action.action)) continue;
    if (action.action === "create" && movesBlockedByDeleteSafety.has(action.listenerId)) {
      skipped.push(action);
      continue;
    }
    const listener = action.listenerId ? desiredById.get(action.listenerId) : undefined;
    const repositoryPath = splitRepository(action.repository);
    if (action.action === "delete") {
      await Effect.runPromise(client.request("DELETE", `/repos/${repositoryPath}/hooks/${action.hookId}`));
      nextState.github = nextState.github.filter(
        (owned) => !(owned.repository === action.repository && owned.hookId === action.hookId),
      );
    } else {
      if (!listener) throw invalidConfig(`Listener "${action.listenerId}" disappeared while applying the plan.`);
      const body = {
        name: "web",
        active: listener.active,
        events: normalizedEvents(listener.events),
        config: {
          url: listener.callbackUrl,
          content_type: "json",
          insecure_ssl: "0",
          secret: secrets.get(listener.id),
        },
      };
      const hook =
        action.action === "create"
          ? await Effect.runPromise(client.request("POST", `/repos/${repositoryPath}/hooks`, body))
          : await Effect.runPromise(client.request("PATCH", `/repos/${repositoryPath}/hooks/${action.hookId}`, body));
      const hookId = Number(hook?.id ?? action.hookId);
      if (!Number.isInteger(hookId) || hookId <= 0)
        throw new IntegrationError(
          "decode-failed",
          `GitHub did not return a valid hook id for listener "${listener.id}".`,
          { listenerId: listener.id },
        );
      nextState.github = nextState.github.filter((owned) => owned.listenerId !== listener.id);
      nextState.github.push({
        listenerId: listener.id,
        repository: listener.repository,
        hookId,
        callbackUrl: listener.callbackUrl,
        secretDigest: digests.get(listener.id),
      });
    }
    // Persist ownership immediately after each remote mutation. If a later
    // repository fails, the next reconciliation can still safely identify and
    // converge every hook changed before that failure.
    writeListenerOwnershipState(workspaceRoot, nextState);
    applied.push(action);
  }
  writeListenerOwnershipState(workspaceRoot, nextState);
  return { ...plan, applied, skipped };
}
