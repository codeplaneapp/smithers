import { describe, expect, test } from "bun:test";
import {
  DELEGATION_V2_CRITICAL_EXECUTION_POLICY_VERSION,
  bindCriticalExecutionGrant,
  deriveCriticalReviewIndependentRoles,
  deriveCriticalExecutionGrant,
  normalizeCriticalExecutionPolicy,
  normalizeCriticalReviewIndependentRoles,
  verifyBoundCriticalExecutionGrant,
} from "../src/components/delegation-v2/delegationV2CriticalExecution.js";

const request = {
  category: "concurrency_invariant",
  invariant: "Only one durable claim may win.",
  whyHighTierIsRequired: "The ordering proof spans the transaction boundary.",
  whyTheCoreCannotBeDelegated: "Splitting the mutation and proof loses the atomicity invariant.",
  allowedPaths: ["packages/db/src/claim.js"],
  expectedChangedLines: 24,
  lineSensitivity: "Each branch participates in the exactly-once proof.",
  surroundingWorkDelegatedTo: ["test-race"],
  reviewNodeId: "review-claim",
};

describe("Trellis trusted critical-execution policy", () => {
  test("derives reviewer independence from configured agent and failover aliases", () => {
    const sol = { id: "sol-agent", generate() {} };
    const shared = { id: "shared-agent", generate() {} };
    const luna = { id: "luna-agent", generate() {} };
    const roles = deriveCriticalReviewIndependentRoles({
      sol,
      fable: [shared],
      terra: shared,
      luna,
    });
    expect(roles).toEqual({
      sol: ["fable", "terra", "luna"],
      fable: ["sol", "luna"],
    });
    expect(normalizeCriticalReviewIndependentRoles(roles)).toEqual({
      sol: ["fable", "luna", "terra"],
      fable: ["luna", "sol"],
    });

    const sameIdWrapper = { id: "sol-agent", generate() {} };
    expect(
      deriveCriticalReviewIndependentRoles({
        sol,
        fable: sameIdWrapper,
        terra: { id: "terra-agent", generate() {} },
        luna,
      }).sol,
    ).toEqual(["terra", "luna"]);
  });

  test("absence disables direct high-tier implementation", () => {
    const result = deriveCriticalExecutionGrant(request, null);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0].code).toBe("criticality_ungranted");
  });

  test("normalizes and hashes a strict caller-owned policy", () => {
    const policy = normalizeCriticalExecutionPolicy({
      allowedCategories: ["protocol_core", "concurrency_invariant"],
      allowedPathPrefixes: ["packages/engine", "packages/db/src"],
      maxChangedLines: 40,
    });
    expect(policy).toEqual({
      policyVersion: DELEGATION_V2_CRITICAL_EXECUTION_POLICY_VERSION,
      allowedCategories: ["concurrency_invariant", "protocol_core"],
      allowedPathPrefixes: ["packages/db/src", "packages/engine"],
      maxChangedLines: 40,
      policyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(normalizeCriticalExecutionPolicy(policy)).toEqual(policy);
    expect(() =>
      normalizeCriticalExecutionPolicy({
        allowedCategories: ["protocol_core"],
        allowedPathPrefixes: ["../outside"],
        maxChangedLines: 40,
      }),
    ).toThrow("'..'");
    expect(() =>
      normalizeCriticalExecutionPolicy({
        allowedCategories: ["protocol_core"],
        allowedPathPrefixes: ["packages/*"],
        maxChangedLines: 40,
      }),
    ).toThrow("glob");
    expect(() =>
      normalizeCriticalExecutionPolicy({
        allowedCategories: ["protocol_core"],
        allowedPathPrefixes: ["packages/engine\u0000/escape"],
        maxChangedLines: 40,
      }),
    ).toThrow("control");
  });

  test("derives a canonical grant only inside category, path, and line bounds", () => {
    const policy = normalizeCriticalExecutionPolicy({
      allowedCategories: ["concurrency_invariant"],
      allowedPathPrefixes: ["packages/db/src"],
      maxChangedLines: 40,
    });
    const accepted = deriveCriticalExecutionGrant(request, policy);
    expect(accepted.ok).toBe(true);
    expect(accepted.grant).toMatchObject({
      policyHash: policy.policyHash,
      category: "concurrency_invariant",
      allowedPaths: ["packages/db/src/claim.js"],
      expectedChangedLines: 24,
      maxChangedLines: 40,
      reviewNodeId: "review-claim",
    });

    for (const changed of [
      { category: "security_boundary" },
      { allowedPaths: ["packages/db2/src/claim.js"] },
      { expectedChangedLines: 41 },
    ]) {
      const rejected = deriveCriticalExecutionGrant({ ...request, ...changed }, policy);
      expect(rejected.ok).toBe(false);
      expect(rejected.diagnostics.every((item) => item.code === "criticality_policy_mismatch")).toBe(true);
    }
  });

  test("binds an admitted grant to one immutable compiled actor", () => {
    const policy = normalizeCriticalExecutionPolicy({
      allowedCategories: ["concurrency_invariant"],
      allowedPathPrefixes: ["packages/db/src"],
      maxChangedLines: 40,
    });
    const admitted = deriveCriticalExecutionGrant(request, policy);
    expect(admitted.ok).toBe(true);
    const actor = {
      invocationKey: "trellis:root:0123456789abcdef01234567",
      programId: "critical-program",
      programDigest: "a".repeat(64),
      logicalId: "critical-core",
      role: "sol",
      work: "execute",
    };
    const first = bindCriticalExecutionGrant(admitted.grant, actor);
    const second = bindCriticalExecutionGrant(admitted.grant, { ...actor, logicalId: "other-core" });
    expect(verifyBoundCriticalExecutionGrant(first)).toBe(first);
    expect(first).toMatchObject({ actor, grantHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(first.grantHash).not.toBe(second.grantHash);
    expect(() => verifyBoundCriticalExecutionGrant({ ...first, logicalId: "forged" })).toThrow("hash");
  });
});
