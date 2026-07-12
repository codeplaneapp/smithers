type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
}

function positiveId(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return String(value);
}

export interface ReviewCredentialPolicyDecision {
  subscriptionEligible: false;
  mode: "proxy";
  reason: string;
}

/**
 * PR automation is always proxy-only. A same-repository pull request can edit
 * the outer `pull_request` workflow before any runtime policy executes, so no
 * actor/branch predicate inside that workflow can safely unlock a repository
 * secret. A future subscription path must use a separately reviewed,
 * base-controlled trigger; this action deliberately has no such override.
 */
export function reviewCredentialPolicy(): ReviewCredentialPolicyDecision {
  return {
    subscriptionEligible: false,
    mode: "proxy",
    reason: "pull request automation never accepts long-lived subscription credentials",
  };
}

/** Whether this event's own token can be expected to publish back to the PR. */
export function eventCanPublish(eventName: string, payload: unknown): boolean {
  if (eventName === "issue_comment") return true;
  if (eventName === "pull_request_target") return true;
  if (eventName !== "pull_request") return false;
  const top = obj(payload);
  const pr = obj(top?.pull_request);
  const headRepo = obj(obj(pr?.head)?.repo);
  const baseRepo = obj(obj(pr?.base)?.repo);
  const headId = positiveId(headRepo?.id);
  const baseId = positiveId(baseRepo?.id);
  return Boolean(headId && baseId && headId === baseId);
}
