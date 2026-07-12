/**
 * Pure decision: should this workflow run a review for the given GitHub event
 * payload? Two events count:
 *
 *   pull_request_target  non-draft same-repository PR or a fork authored by an
 *                  owner/member/collaborator, and only for
 *                  actions that change the reviewable diff: opened,
 *                  synchronize, reopened, ready_for_review. Everything else
 *                  (labeled, edited, assigned, …) skips with a reason. Other
 *                  forks require the maintainer-only comment trigger so an
 *                  external actor cannot exhaust review quota.
 *   issue_comment  action is "created" (edited/deleted comments never
 *                  re-trigger), comment is on a PR, body starts with the magic
 *                  phrase "@smithers review", and the author's association is
 *                  OWNER / MEMBER / COLLABORATOR.
 *
 * Returns the PR number (and the head SHA for pull request events, when
 * present) so the orchestrator can pass it to the CLI.
 */
const MAGIC_PHRASE = "@smithers review";
const COLLAB_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REVIEWABLE_PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type GateInputEvent = "pull_request" | "pull_request_target" | "issue_comment";

export type GateDecision =
  | {
      run: true;
      eventName: GateInputEvent;
      prNumber: number;
      headSha?: string;
      baseSha?: string;
    }
  | {
      run: false;
      reason: string;
    };

export interface GateInput {
  eventName: string;
  payload: unknown;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function gateEvent({ eventName, payload }: GateInput): GateDecision {
  const top = obj(payload) ?? {};

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const action = typeof top.action === "string" ? top.action : "";
    if (!REVIEWABLE_PR_ACTIONS.has(action)) {
      return {
        run: false,
        reason: `pull_request action "${action || "(missing)"}" does not change the diff (reviewed on: opened, synchronize, reopened, ready_for_review)`,
      };
    }
    const pr = obj(top.pull_request);
    if (!pr) return { run: false, reason: "pull_request event missing pull_request payload" };
    if (pr.draft !== false) return { run: false, reason: "pull request draft state is missing or draft" };
    const head = obj(pr.head);
    const base = obj(pr.base);
    const headRepo = obj(head?.repo);
    const baseRepo = obj(base?.repo);
    if (typeof headRepo?.full_name !== "string" || typeof baseRepo?.full_name !== "string") {
      return { run: false, reason: "pull_request event missing head/base repository identity" };
    }
    const sameRepository = headRepo.full_name === baseRepo.full_name;
    const association = pr.author_association;
    if (!sameRepository && (typeof association !== "string" || !COLLAB_ASSOCIATIONS.has(association))) {
      return {
        run: false,
        reason: "untrusted fork pull requests require a maintainer @smithers review comment",
      };
    }
    const number = pr.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
      return { run: false, reason: "pull_request event missing pull request number" };
    }
    const sha = typeof head?.sha === "string" && SHA.test(head.sha) ? head.sha : undefined;
    if (!sha) return { run: false, reason: "pull_request event missing head SHA" };
    const baseSha = typeof base?.sha === "string" && SHA.test(base.sha) ? base.sha : undefined;
    if (!baseSha) return { run: false, reason: "pull_request event missing base SHA" };
    return {
      run: true,
      eventName: eventName as "pull_request" | "pull_request_target",
      prNumber: number,
      headSha: sha,
      baseSha,
    };
  }

  if (eventName === "issue_comment") {
    const action = typeof top.action === "string" ? top.action : "";
    if (action !== "created") {
      // Only a freshly posted comment triggers a review. Editing or deleting a
      // comment that starts with the magic phrase would otherwise re-run (and
      // could be spammed to re-run) a review the diff has not changed for.
      return {
        run: false,
        reason: `issue_comment action "${action || "(missing)"}" is not "created"`,
      };
    }
    const issue = obj(top.issue);
    const comment = obj(top.comment);
    if (!issue || !obj(issue.pull_request)) {
      return { run: false, reason: "comment is not on a pull request" };
    }
    const rawBody = comment?.body;
    const body = typeof rawBody === "string" ? rawBody.trim().toLowerCase() : "";
    if (!body.startsWith(MAGIC_PHRASE)
      || (body.length > MAGIC_PHRASE.length && /[a-z0-9_]/.test(body[MAGIC_PHRASE.length]))) {
      return { run: false, reason: `comment does not start with "${MAGIC_PHRASE}"` };
    }
    const assoc = comment?.author_association;
    if (typeof assoc !== "string" || !COLLAB_ASSOCIATIONS.has(assoc)) {
      return {
        run: false,
        reason: `comment author association "${String(assoc)}" is not OWNER/MEMBER/COLLABORATOR`,
      };
    }
    const number = issue.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
      return { run: false, reason: "issue_comment payload missing PR number" };
    }
    return { run: true, eventName: "issue_comment", prNumber: number };
  }

  return { run: false, reason: `unsupported event "${eventName}"` };
}
