import { describe, expect, test } from "bun:test";
import { eventCanPublish, reviewCredentialPolicy } from "../../action/src/reviewTrustPolicy";

describe("review credential and publication policy", () => {
  test("PR automation is unconditionally proxy-only", () => {
    expect(reviewCredentialPolicy()).toEqual({
      subscriptionEligible: false,
      mode: "proxy",
      reason: "pull request automation never accepts long-lived subscription credentials",
    });
  });

  test("same-repo pull_request and issue_comment events are publishable, forks are not", () => {
    const sameRepo = {
      pull_request: {
        head: { repo: { id: 100 } },
        base: { repo: { id: 100 } },
      },
    };
    const fork = {
      pull_request: {
        head: { repo: { id: 200 } },
        base: { repo: { id: 100 } },
      },
    };
    expect(eventCanPublish("pull_request", sameRepo)).toBe(true);
    expect(eventCanPublish("pull_request", fork)).toBe(false);
    expect(eventCanPublish("pull_request_target", fork)).toBe(true);
    expect(eventCanPublish("issue_comment", {})).toBe(true);
    expect(eventCanPublish("push", {})).toBe(false);
  });

  test("missing repository IDs fail publication closed", () => {
    expect(eventCanPublish("pull_request", {
      pull_request: { head: { repo: {} }, base: { repo: { id: 100 } } },
    })).toBe(false);
  });
});
