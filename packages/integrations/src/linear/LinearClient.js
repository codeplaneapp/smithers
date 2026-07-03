// @smithers-type-exports-begin
/** @typedef {import("./LinearClientTypes.ts").CreateIssueInput} CreateIssueInput */
/** @typedef {import("./LinearClientTypes.ts").LinearClientService} LinearClientService */
/** @typedef {import("./LinearClientTypes.ts").LinearCommentResult} LinearCommentResult */
/** @typedef {import("./LinearClientTypes.ts").LinearIssueResult} LinearIssueResult */
/** @typedef {import("./LinearClientTypes.ts").LinearPriority} LinearPriority */
/** @typedef {import("./LinearClientTypes.ts").LinearTeamRef} LinearTeamRef */
/** @typedef {import("./LinearConfig.ts").LinearConfig} LinearConfig */
// @smithers-type-exports-end

import { Context, Effect, Layer } from "effect";
import { IntegrationError } from "../core/IntegrationError.js";
import { resolveLinearConfig } from "./config.js";

/** Context tag for the Linear GraphQL client service. */
export const LinearClient = /** @type {Context.Tag<LinearClientService, LinearClientService>} */ (
    Context.GenericTag("@smithers-orchestrator/integrations/linear/LinearClient"));

/**
 * Layer providing {@link LinearClient} from config (explicit >
 * `configureLinear` > env).
 * @param {LinearConfig} [config]
 */
export function LinearClientLive(config) {
    return Layer.sync(LinearClient, () => makeLinearClient(config));
}

// Eliza plugin-linear's priority vocabulary: 1 urgent, 2 high, 3 normal, 4 low.
/** @type {Record<string, number>} */
const PRIORITY_BY_NAME = {
    none: 0,
    urgent: 1,
    high: 2,
    normal: 3,
    medium: 3,
    low: 4,
};

/** Issue identifier like `ENG-123` (vs a UUID). */
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * Normalize a priority name or number to Linear's 0–4 scale.
 * @param {LinearPriority | undefined} priority
 * @returns {number | undefined}
 */
export function normalizeLinearPriority(priority) {
    if (priority === undefined) {
        return undefined;
    }
    if (typeof priority === "number") {
        if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
            throw new IntegrationError("decode-failed", `Invalid Linear priority number: ${priority} (expected 0-4).`, { priority });
        }
        return priority;
    }
    const mapped = PRIORITY_BY_NAME[String(priority).toLowerCase()];
    if (mapped === undefined) {
        throw new IntegrationError("decode-failed", `Unknown Linear priority name: "${priority}".`, { priority });
    }
    return mapped;
}

const MAX_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Retry delay from Linear rate-limit headers: `Retry-After` (seconds) or
 * `X-RateLimit-Requests-Reset` (unix epoch ms), clamped to 30s.
 * @param {Headers} headers
 * @returns {number | undefined}
 */
function retryDelayFromHeaders(headers) {
    const retryAfter = headers.get("retry-after");
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
        }
    }
    const reset = headers.get("x-ratelimit-requests-reset");
    if (reset) {
        const resetMs = Number(reset);
        if (Number.isFinite(resetMs) && resetMs > 0) {
            return Math.min(Math.max(resetMs - Date.now(), 0), MAX_RETRY_DELAY_MS);
        }
    }
    return undefined;
}

const ISSUE_FIELDS = "id identifier title url team { id key }";

const TEAM_BY_KEY_QUERY = `query TeamByKey($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) { nodes { id key name } }
}`;
const WORKFLOW_STATES_QUERY = `query WorkflowStates($teamId: ID!) {
  workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { id name type } }
}`;
const ISSUE_LABELS_QUERY = `query IssueLabels($teamId: ID!) {
  issueLabels(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { id name } }
}`;
const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`;
const ISSUE_CREATE_MUTATION = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;
const ISSUE_UPDATE_MUTATION = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;
const COMMENT_CREATE_MUTATION = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body issue { id identifier } } }
}`;

/**
 * Build a plain-fetch Linear GraphQL client. Behaviors ported from
 * eliza's plugin-linear (via @linear/sdk) reimplemented over raw GraphQL:
 * team lookup by key, workflow-state / label name resolution (cached per
 * client), issueCreate/issueUpdate/commentCreate, issue lookup by
 * `ENG-123` identifier, 429/5xx retry honoring rate-limit headers.
 *
 * The API key is only used for the `Authorization` header — never logged
 * and never included in error details.
 *
 * @param {LinearConfig} [config]
 * @returns {LinearClientService}
 */
export function makeLinearClient(config) {
    const resolved = resolveLinearConfig(config);
    const { apiKey, apiBaseUrl } = resolved;

    // Per-client lookup caches (team key → team, teamId → states/labels).
    /** @type {Map<string, LinearTeamRef>} */
    const teamByKey = new Map();
    /** @type {Map<string, { id: string; name: string }[]>} */
    const statesByTeam = new Map();
    /** @type {Map<string, { id: string; name: string }[]>} */
    const labelsByTeam = new Map();

    /**
     * @param {string} gql
     * @param {Record<string, unknown>} [variables]
     * @returns {Effect.Effect<any, import("@smithers-orchestrator/errors/SmithersError").SmithersError>}
     */
    const query = (gql, variables) => Effect.gen(function* () {
        if (!apiKey) {
            return yield* Effect.fail(new IntegrationError("delivery-failed", "Linear API key is not configured. Pass config.apiKey, call configureLinear({ apiKey }), or set SMITHERS_LINEAR_API_KEY.", { apiBaseUrl }));
        }
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            const response = yield* Effect.tryPromise({
                try: () => fetch(apiBaseUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        // Personal API keys go raw; OAuth tokens arrive pre-prefixed.
                        Authorization: apiKey,
                    },
                    body: JSON.stringify({ query: gql, variables: variables ?? {} }),
                }),
                catch: (cause) => new IntegrationError("delivery-failed", "Linear API request failed (network error).", { apiBaseUrl }, { cause }),
            });
            if (response.status === 429 || response.status >= 500) {
                const retryable = attempt < MAX_ATTEMPTS;
                const delayMs = retryDelayFromHeaders(response.headers) ??
                    Math.min(250 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
                if (!retryable) {
                    return yield* Effect.fail(new IntegrationError("delivery-failed", `Linear API responded ${response.status} after ${attempt} attempts.`, { status: response.status, apiBaseUrl }));
                }
                yield* Effect.sleep(`${delayMs} millis`);
                continue;
            }
            const json = yield* Effect.tryPromise({
                try: () => response.json(),
                catch: (cause) => new IntegrationError("decode-failed", `Linear API returned a non-JSON response (status ${response.status}).`, { status: response.status }, { cause }),
            });
            if (!response.ok) {
                return yield* Effect.fail(new IntegrationError("delivery-failed", `Linear API responded ${response.status}.`, {
                    status: response.status,
                    errors: json?.errors?.map((/** @type {any} */ e) => e?.message) ?? undefined,
                }));
            }
            if (Array.isArray(json?.errors) && json.errors.length > 0) {
                return yield* Effect.fail(new IntegrationError("delivery-failed", `Linear GraphQL error: ${json.errors
                    .map((/** @type {any} */ e) => e?.message ?? "unknown")
                    .join("; ")}`, { errors: json.errors.map((/** @type {any} */ e) => e?.message) }));
            }
            return json?.data;
        }
        // Unreachable — the loop either returns or fails.
        return yield* Effect.fail(new IntegrationError("delivery-failed", "Linear API retry loop exhausted.", { apiBaseUrl }));
    });

    /**
     * @param {{ teamId?: string; teamKey?: string }} ref
     * @returns {Effect.Effect<LinearTeamRef, import("@smithers-orchestrator/errors/SmithersError").SmithersError>}
     */
    const resolveTeam = (ref) => Effect.gen(function* () {
        if (ref.teamId) {
            return { id: ref.teamId, key: ref.teamKey };
        }
        const key = ref.teamKey?.trim();
        if (!key) {
            return yield* Effect.fail(new IntegrationError("decode-failed", "Linear team is required: pass teamId or teamKey.", {}));
        }
        const cached = teamByKey.get(key.toUpperCase());
        if (cached) {
            return cached;
        }
        const data = yield* query(TEAM_BY_KEY_QUERY, { key });
        const team = data?.teams?.nodes?.[0];
        if (!team?.id) {
            return yield* Effect.fail(new IntegrationError("decode-failed", `Linear team with key "${key}" not found.`, { teamKey: key }));
        }
        /** @type {LinearTeamRef} */
        const result = { id: team.id, key: team.key, name: team.name };
        teamByKey.set(key.toUpperCase(), result);
        return result;
    });

    /**
     * @param {string} teamId
     * @returns {Effect.Effect<{ id: string; name: string }[], import("@smithers-orchestrator/errors/SmithersError").SmithersError>}
     */
    const listStates = (teamId) => Effect.gen(function* () {
        const cached = statesByTeam.get(teamId);
        if (cached) {
            return cached;
        }
        const data = yield* query(WORKFLOW_STATES_QUERY, { teamId });
        const states = data?.workflowStates?.nodes ?? [];
        statesByTeam.set(teamId, states);
        return states;
    });

    /**
     * @param {string} teamId
     * @param {string} stateName
     */
    const resolveStateId = (teamId, stateName) => Effect.gen(function* () {
        const states = yield* listStates(teamId);
        const match = states.find((state) => state.name?.toLowerCase() === stateName.toLowerCase());
        if (!match) {
            return yield* Effect.fail(new IntegrationError("decode-failed", `Linear workflow state "${stateName}" not found for team.`, { teamId, stateName, known: states.map((s) => s.name) }));
        }
        return match.id;
    });

    /**
     * @param {string} teamId
     * @param {string[]} names
     */
    const resolveLabelIds = (teamId, names) => Effect.gen(function* () {
        let labels = labelsByTeam.get(teamId);
        if (!labels) {
            const data = yield* query(ISSUE_LABELS_QUERY, { teamId });
            labels = data?.issueLabels?.nodes ?? [];
            labelsByTeam.set(teamId, labels ?? []);
        }
        const ids = [];
        const missing = [];
        for (const name of names) {
            const match = labels?.find((label) => label.name?.toLowerCase() === name.toLowerCase());
            if (match) {
                ids.push(match.id);
            }
            else {
                missing.push(name);
            }
        }
        if (missing.length > 0) {
            return yield* Effect.fail(new IntegrationError("decode-failed", `Linear label(s) not found for team: ${missing.join(", ")}.`, { teamId, missing }));
        }
        return ids;
    });

    /**
     * @param {string} idOrIdentifier
     * @returns {Effect.Effect<LinearIssueResult, import("@smithers-orchestrator/errors/SmithersError").SmithersError>}
     */
    const getIssue = (idOrIdentifier) => Effect.gen(function* () {
        const data = yield* query(ISSUE_QUERY, { id: idOrIdentifier });
        const issue = data?.issue;
        if (!issue?.id) {
            return yield* Effect.fail(new IntegrationError("decode-failed", `Linear issue "${idOrIdentifier}" not found.`, { idOrIdentifier }));
        }
        return issue;
    });

    /**
     * Mutations need the UUID; lookups accept `ENG-123` identifiers.
     * @param {string} idOrIdentifier
     */
    const resolveIssueId = (idOrIdentifier) => IDENTIFIER_RE.test(idOrIdentifier)
        ? Effect.map(getIssue(idOrIdentifier), (issue) => issue.id)
        : Effect.succeed(idOrIdentifier);

    /**
     * Resolve name-based fields (priority/state/labels) into a raw
     * Issue{Create,Update}Input fragment.
     * @param {string | undefined} teamId
     * @param {import("./LinearClientTypes.ts").UpdateIssueFields} fields
     */
    const buildIssueInput = (teamId, fields) => Effect.gen(function* () {
        /** @type {Record<string, unknown>} */
        const input = {};
        if (fields.title !== undefined)
            input["title"] = fields.title;
        if (fields.description !== undefined)
            input["description"] = fields.description;
        if (fields.assigneeId !== undefined)
            input["assigneeId"] = fields.assigneeId;
        if (fields.projectId !== undefined)
            input["projectId"] = fields.projectId;
        if (fields.estimate !== undefined)
            input["estimate"] = fields.estimate;
        if (fields.dueDate !== undefined)
            input["dueDate"] = fields.dueDate;
        const priority = normalizeLinearPriority(fields.priority);
        if (priority !== undefined)
            input["priority"] = priority;
        if (fields.stateId !== undefined) {
            input["stateId"] = fields.stateId;
        }
        else if (fields.stateName !== undefined) {
            if (!teamId) {
                return yield* Effect.fail(new IntegrationError("decode-failed", "Resolving a Linear state name requires the issue's team.", { stateName: fields.stateName }));
            }
            input["stateId"] = yield* resolveStateId(teamId, fields.stateName);
        }
        if (fields.labelIds !== undefined) {
            input["labelIds"] = fields.labelIds;
        }
        else if (fields.labels !== undefined && fields.labels.length > 0) {
            if (!teamId) {
                return yield* Effect.fail(new IntegrationError("decode-failed", "Resolving Linear label names requires the issue's team.", { labels: fields.labels }));
            }
            input["labelIds"] = yield* resolveLabelIds(teamId, fields.labels);
        }
        return input;
    });

    /** @type {LinearClientService["createIssue"]} */
    const createIssue = (input) => Effect.gen(function* () {
        const team = yield* resolveTeam({ teamId: input.teamId, teamKey: input.teamKey });
        const issueInput = yield* buildIssueInput(team.id, input);
        issueInput["teamId"] = team.id;
        const data = yield* query(ISSUE_CREATE_MUTATION, { input: issueInput });
        const payload = data?.issueCreate;
        if (!payload?.success || !payload.issue) {
            return yield* Effect.fail(new IntegrationError("delivery-failed", "Linear issueCreate did not return an issue.", { success: payload?.success ?? false }));
        }
        return payload.issue;
    });

    /** @type {LinearClientService["updateIssue"]} */
    const updateIssue = (idOrIdentifier, fields) => Effect.gen(function* () {
        const needsTeam = (fields.stateName !== undefined && fields.stateId === undefined) ||
            (fields.labels !== undefined && fields.labelIds === undefined);
        let issueId = idOrIdentifier;
        let teamId;
        if (IDENTIFIER_RE.test(idOrIdentifier) || needsTeam) {
            const issue = yield* getIssue(idOrIdentifier);
            issueId = issue.id;
            teamId = issue.team?.id;
        }
        const input = yield* buildIssueInput(teamId, fields);
        const data = yield* query(ISSUE_UPDATE_MUTATION, { id: issueId, input });
        const payload = data?.issueUpdate;
        if (!payload?.success || !payload.issue) {
            return yield* Effect.fail(new IntegrationError("delivery-failed", "Linear issueUpdate did not return an issue.", { success: payload?.success ?? false, idOrIdentifier }));
        }
        return payload.issue;
    });

    /** @type {LinearClientService["commentOnIssue"]} */
    const commentOnIssue = (idOrIdentifier, body) => Effect.gen(function* () {
        const issueId = yield* resolveIssueId(idOrIdentifier);
        const data = yield* query(COMMENT_CREATE_MUTATION, { input: { issueId, body } });
        const payload = data?.commentCreate;
        if (!payload?.success || !payload.comment) {
            return yield* Effect.fail(new IntegrationError("delivery-failed", "Linear commentCreate did not return a comment.", { success: payload?.success ?? false, idOrIdentifier }));
        }
        return payload.comment;
    });

    return {
        query,
        resolveTeam,
        resolveStateId,
        resolveLabelIds,
        getIssue,
        createIssue,
        updateIssue,
        commentOnIssue,
    };
}
