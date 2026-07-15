import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mdxPlugin } from "smithers-orchestrator";
import { canonicalGithubRemote, commitPatchId, completeCandidateSnapshot, disposeIsolatedGateDependencies, dryRunMainIsCurrent, exactCommitMessage, exactLandingProvenance, fixpointDecision, focusedCommands, pathsOverlap, pathsWithinEnvelope, peerPathOverlaps, prepareIsolatedGateDependencies, protectedPaths, publicationBoundaryAuthorized, resolveExecutable, risklessProofId, runIsolatedGate, sanitizedGateEnv, sha256, stableOperationMarker } from "../lib/risklessGithubIssueSweep";

mdxPlugin();
const { renderWorkflow, runTask } = await import("smithers-orchestrator/testing");
const {
  default: workflow,
  candidateEvidenceProof: candidateProofId,
  canonicalAncestorsSecure,
  canonicalRemoteConfiguration,
  closeApprovalProof: closeApprovalId,
  closureCausalChainValid,
  closureProofIdentifier: closureProofId,
  closureRefreshProofIdentifier: closureRefreshProofId,
  commitCandidate,
  commitProofIdentifier: commitProofId,
  exactRemoteTipProven,
  fetchCanonicalMain,
  lunaApprovalProof: lunaApprovalId,
  pinnedCodexConfigDirectory,
  pinnedGithubArgv,
  pinnedGithubConfiguration,
  pinnedGithubEnvironment,
  publicationCausalChainValid,
  publicationLiveStateId: publicationLiveId,
  publicationProofIdentifier: publicationProofId,
  pushCanonicalMain,
  rebaseProofIdentifier: rebaseProofId,
  runPinnedGithub,
} = await import("../workflows/riskless-github-issue-sweep");

type Node = { tag?: string; name?: string; type?: string; props?: Record<string, unknown>; children?: unknown[] };
function walk(value: unknown, visit: (node: Node, loopDepth: number) => void, loopDepth = 0) {
  if (!value || typeof value !== "object") return;
  const node = value as Node; const tag = String(node.tag ?? node.name ?? node.type ?? "").toLowerCase(); const loop = tag.includes("loop") || tag.includes("ralph"); const depth = loopDepth + (loop ? 1 : 0);
  visit(node, depth); for (const child of node.children ?? []) walk(child, visit, depth);
}
const meta = (nodeId: string, iteration = 0) => ({ nodeId, iteration });
const issue = (number: number) => ({ number, title: `Small issue ${number}`, body: "Localized typo with acceptance evidence.", labels: ["bug"], assignees: [], milestone: "", url: `https://github.com/smithersai/smithers/issues/${number}`, author: "reporter", state: "open", identitySha256: `identity-${number}` });
const input = { repo: "smithersai/smithers", excludeNumbers: [], laneConcurrency: 16, reviewIterations: 3, landingRetries: 3, dryRun: false, conservativeLabelHints: [], prompt: "riskless" };
const messageFor = (number: number) => `🐛 fix(components): repair ${number}\n\nFixes #${number}\nCo-Authored-By: Codex <codex@example.com>`;
const command = (argv: string[]) => ({
  argv, exitCode: 0, passed: true, timedOut: false, signal: "", launchError: "",
  beforeHead: "head", afterHead: "head", beforeDigest: "digest", afterDigest: "digest",
  beforeStatusSha256: "clean", afterStatusSha256: "clean", disposableRemoved: true, unchanged: true,
  dependencyBindingId: "binding", dependencyHead: "head", dependencyDigest: "digest", lockfileSha256: "lock",
  dependencyInstallArgv: ["pnpm", "install", "--offline", "--frozen-lockfile"], dependencyInstallExitCode: 0,
  dependencyInstallSignal: "", dependencyInstallError: "", dependencyInstallLog: "offline frozen install complete",
  dependencyBindingRemoved: true, log: "exit 0",
});

type ProofRow = Record<string, any>;

function lateOutputs() {
  const issues = [issue(42), issue(43)];
  const path = (number: number) => `packages/components/src/i${number}.ts`;
  const facts = new Map(issues.map((row) => {
    const changedPaths = [path(row.number)];
    const envelope = [...changedPaths];
    const commitMessage = messageFor(row.number);
    const commitMessageSha256 = sha256(commitMessage);
    const candidate = { baseSha: "base", headSha: `prior-${row.number}`, diffSha256: `diff-${row.number}`, patchId: `patch-${row.number}`, changedPaths, stagePaths: changedPaths };
    const candidateProposal: ProofRow = {
      issueNumber: row.number, issueIdentitySha256: row.identitySha256, baseSha: candidate.baseSha,
      headSha: candidate.headSha, diffSha256: candidate.diffSha256, patchId: candidate.patchId,
      approvalPhase: "candidate-commit", sourceProofId: candidateProofId(row, candidate, envelope, "candidate-commit", 1),
      approvalIteration: 1, envelope, decision: "propose", valid: true, stagePaths: changedPaths,
      changedPaths, commitMessage, rationale: "exact candidate approval",
    };
    const candidateCommit: ProofRow = {
      issueNumber: row.number, issueIdentitySha256: row.identitySha256, baseSha: "base", parentSha: "base",
      preCommitHeadSha: candidate.headSha, commitSha: `head-${row.number}`, headSha: `head-${row.number}`,
      diffSha256: candidate.diffSha256, patchId: candidate.patchId, envelope,
      approvalPhase: "candidate-commit", approvalIteration: 1, sourceApprovalId: lunaApprovalId(candidateProposal),
      commitMessageSha256, decision: "committed", exactlyOneCommit: true, clean: true, exactStagePaths: true,
      exactChangedPaths: true, protectedPathClean: true, messageValid: true, changedPaths, failure: "",
    };
    candidateCommit.proofId = commitProofId(candidateCommit);

    const landingCandidate = { baseSha: "base", headSha: candidateCommit.headSha, diffSha256: `landing-correction-${row.number}`, patchId: candidate.patchId, changedPaths, stagePaths: changedPaths };
    const landingProposal: ProofRow = {
      issueNumber: row.number, issueIdentitySha256: row.identitySha256, baseSha: landingCandidate.baseSha,
      headSha: landingCandidate.headSha, diffSha256: landingCandidate.diffSha256, patchId: landingCandidate.patchId,
      approvalPhase: "landing-amend", sourceProofId: candidateProofId(row, landingCandidate, envelope, "landing-amend", 2),
      approvalIteration: 2, envelope, decision: "propose", valid: true, stagePaths: changedPaths,
      changedPaths, commitMessage, rationale: "exact landing amendment approval",
    };
    const landingCommit: ProofRow = {
      issueNumber: row.number, issueIdentitySha256: row.identitySha256, baseSha: "base", parentSha: "base",
      preCommitHeadSha: landingCandidate.headSha, commitSha: `corrected-${row.number}`, headSha: `corrected-${row.number}`,
      diffSha256: landingCandidate.diffSha256, patchId: landingCandidate.patchId, envelope,
      approvalPhase: "landing-amend", approvalIteration: 2, sourceApprovalId: lunaApprovalId(landingProposal),
      commitMessageSha256, decision: "committed", exactlyOneCommit: true, clean: true, exactStagePaths: true,
      exactChangedPaths: true, protectedPathClean: true, messageValid: true, changedPaths, failure: "",
    };
    landingCommit.proofId = commitProofId(landingCommit);

    const rebase: ProofRow = {
      issueNumber: row.number, issueIdentitySha256: row.identitySha256, sourceCommitProofId: landingCommit.proofId,
      approvalIteration: 2, envelope, oldBaseSha: "base", newBaseSha: "base2", sourceCommitSha: landingCommit.commitSha,
      headSha: `rebased-${row.number}`, diffSha256: `landing-diff-${row.number}`, patchId: candidate.patchId,
      commitMessageSha256, status: "rebased", exactlyOneCommit: true, messageValid: true, protectedPathClean: true,
      clean: true, abortRestored: true, exactChangedPaths: true, changedPaths, decision: "review", summary: "causal rebase proved",
    };
    rebase.proofId = rebaseProofId(rebase);

    const publicationProposal: ProofRow = {
      issueNumber: row.number, issueIdentitySha256: row.identitySha256, baseSha: "base2",
      headSha: rebase.headSha, diffSha256: rebase.diffSha256, patchId: rebase.patchId,
      approvalPhase: "publication", sourceProofId: rebase.proofId,
      approvalIteration: 2, envelope, decision: "propose", valid: true, stagePaths: [], changedPaths,
      commitMessage, rationale: "exact publication approval",
    };
    const landingApprovalId = lunaApprovalId(publicationProposal);
    const liveState = {
      provenanceKind: "normal", sourceRebaseProofId: rebase.proofId, landingApprovalId, issueNumber: row.number,
      issueIdentitySha256: row.identitySha256, remoteSha: "base2", lsRemoteSha: "base2", issueState: "open",
      liveIssueIdentitySha256: row.identitySha256, canonicalOrigin: true, collisionOk: true, collisions: [], fixes: [],
      equivalents: [], queriesOk: true, clean: true, commitSha: rebase.headSha, parentSha: "base2", diffSha256: rebase.diffSha256,
      patchId: rebase.patchId, changedPaths, envelope, commitMessageSha256, approvalIteration: 2,
    };
    const publication: ProofRow = {
      issueNumber: row.number, provenanceKind: "normal", issueIdentitySha256: row.identitySha256, envelope,
      sourceRebaseProofId: rebase.proofId, landingApprovalId, liveStateId: publicationLiveId(liveState),
      commitSha: rebase.headSha, candidateParentSha: "base2", commitMessageSha256,
      diffSha256: rebase.diffSha256, patchId: rebase.patchId, changedPaths, approvalIteration: 2,
      provenanceMatches: true, collisionEvidenceOk: true, pushed: row.number === 42, reachable: true,
      alreadyReachable: row.number === 43, retryableRace: false, fetchExitCode: 0,
      prePushRemoteSha: "base2", postPushRemoteSha: rebase.headSha, remoteBaseSha: rebase.headSha,
      originUrl: "https://github.com/smithersai/smithers.git", pushUrl: "git@github.com:smithersai/smithers.git",
      canonicalOrigin: true, issueIdentityMatches: true, equivalenceConsistent: true,
      decision: row.number === 42 ? "published" : "reachable", summary: "fresh publication boundary proved",
    };
    publication.proofId = publicationProofId(publication);

    const marker = stableOperationMarker("smithersai/smithers", row.number, rebase.headSha);
    const closureRefresh: ProofRow = {
      issueNumber: row.number, sourcePublicationProofId: publication.proofId, issueIdentitySha256: row.identitySha256,
      commitMessageSha256, remoteMainSha: rebase.headSha, headSha: rebase.headSha, diffSha256: rebase.diffSha256,
      patchId: rebase.patchId, changedPaths, approvalIteration: 2, envelope, closureAttempt: 1, ready: true,
      fetchExitCode: 0, canonicalOrigin: true, reachable: true, issueState: row.number === 43 ? "closed" : "open",
      identityMatches: true, commentsEnumerated: true, markerPresent: row.number === 43, operationMarker: marker,
      decision: "authorize", summary: "fresh closure boundary proved",
    };
    closureRefresh.proofId = closureRefreshProofId(closureRefresh);
    const closeProposal: ProofRow = {
      issueNumber: row.number, sourceClosureRefreshId: closureRefresh.proofId, headSha: rebase.headSha,
      diffSha256: rebase.diffSha256, patchId: rebase.patchId, changedPaths, approvalIteration: 2, envelope,
      closureAttempt: 1, decision: "close", comment: `Landed in ${rebase.headSha}.`, operationMarker: marker,
      rationale: "fresh reachable publication",
    };
    return [row.number, { candidate, candidateProposal, candidateCommit, landingCandidate, landingProposal, landingCommit, rebase, publicationProposal, publication, closureRefresh, closeProposal, closeApprovalId: closeApprovalId(closeProposal) }] as const;
  }));
  const fact = (number: number) => facts.get(number)!;

  return {
    normalizeInputs: [{ ...meta("normalize-inputs"), valid: true, ...input, protectedPaths: [".github"], summary: "normalized" }],
    synchronizeMain: [{ ...meta("synchronize-main"), safeToProceed: true, canonicalOrigin: true, originUrl: "git@github.com:smithersai/smithers.git", pushUrl: "git@github.com:smithersai/smithers.git", fetchExitCode: 0, localMainSha: "old-base", remoteMainSha: "base", classificationRoot: "/tmp/classification", clean: true, onMain: true, summary: "snapshot" }],
    discoverIssues: [{ ...meta("discover-issues"), repo: "smithersai/smithers", baseSha: "base", preEnumerationSha: "base", postEnumerationSha: "base", classificationHeadSha: "base", classificationSnapshotReady: true, enumerationBaseStable: true, issues, globalIndex: issues.map(({ number, title, labels, assignees, milestone, identitySha256 }) => ({ number, title, labels, assignees, milestone, identitySha256 })), completeMachineJson: "[[{machine:true}]]", discoveredCount: 2, discoverySha256: "discovery", summary: "complete" }],
    classify: issues.map((row) => ({ ...meta(`i${row.number}:classify`), issueNumber: row.number, headSha: "base", diffSha256: row.identitySha256, issueIdentitySha256: row.identitySha256, decision: "admit", disposition: "admit", eligible: true, evidence: ["source evidence"], acceptanceCriteria: ["focused test"], likelyPaths: [path(row.number)], riskFlags: [], overlapIssueNumbers: [], rationale: "localized" })),
    adjudicate: issues.map((row) => ({ ...meta(`i${row.number}:adjudicate`), issueNumber: row.number, headSha: "base", diffSha256: row.identitySha256, issueIdentitySha256: row.identitySha256, decision: "admit", disposition: "admit", approved: true, evidence: ["independent evidence"], acceptanceCriteria: ["focused test"], likelyPaths: [path(row.number)], riskFlags: [], overlapIssueNumbers: [], rationale: "localized" })),
    admissionLedger: [{ ...meta("admission-ledger"), valid: true, coverageComplete: true, syncProven: true, discoveredCount: 2, consideredCount: 2, admittedIssueNumbers: [42, 43], dispositions: issues.map((row) => ({ issueNumber: row.number, disposition: "admitted", reason: "two current roles", evidence: ["bound"], missingRoles: [], likelyPaths: [path(row.number)], issueIdentitySha256: row.identitySha256 })), summary: "covered" }],
    laneBootstrap: issues.map((row) => ({ ...meta(`i${row.number}:lane-bootstrap`), issueNumber: row.number, ready: true, canonicalOrigin: true, originUrl: "https://github.com/smithersai/smithers.git", pushUrl: "git@github.com:smithersai/smithers.git", fetchExitCode: 0, oldBaseSha: "old-base", baseSha: "base", headSha: "base", clean: true, decision: "ready", summary: "latest lane base" })),
    liveRefresh: issues.map((row) => ({ ...meta(`i${row.number}:live-refresh`), issueNumber: row.number, ready: true, issueOpen: true, identityMatches: true, issueIdentitySha256: row.identitySha256, currentOriginSha: "base", activeExclusion: false, collisionEvidenceOk: true, globalIndexCurrent: true, activeCollisionPaths: [], matchingFixesCommits: [], equivalentCommits: [], recoveryCommitSha: "", recoveryDiffSha256: "", recoveryPatchId: "", recoveryChangedPaths: [], decision: "implement", evidence: ["fresh canonical collision-free"], summary: "fresh" })),
    candidateEvidence: issues.flatMap((row) => [
      { ...meta(`i${row.number}:attempt-evidence`, 1), issueNumber: row.number, baseSha: "base", headSha: `prior-${row.number}`, diffSha256: `attempt-diff-${row.number}`, patchId: `attempt-patch-${row.number}`, changedPaths: [path(row.number)], stagePaths: [path(row.number)], completePatch: "prior full patch", byteLength: 16, tooLarge: false, clean: false, statusSha256: "dirty", decision: "captured", summary: "prior attempt" },
      { ...meta(`i${row.number}:review-evidence`, 1), issueNumber: row.number, baseSha: "base", headSha: fact(row.number).candidateCommit.headSha, diffSha256: fact(row.number).candidateCommit.diffSha256, patchId: fact(row.number).candidateCommit.patchId, changedPaths: [path(row.number)], stagePaths: [], completePatch: "candidate full patch", byteLength: 20, tooLarge: false, clean: true, statusSha256: "clean", decision: "captured", summary: "candidate" },
      { ...meta(`i${row.number}:landing-correction-evidence`, 2), issueNumber: row.number, ...fact(row.number).landingCandidate, completePatch: "landing correction patch", byteLength: 24, tooLarge: false, clean: false, statusSha256: "dirty", decision: "captured", summary: "landing correction" },
      { ...meta(`i${row.number}:landing-evidence`, 2), issueNumber: row.number, baseSha: "base2", headSha: fact(row.number).rebase.headSha, diffSha256: fact(row.number).rebase.diffSha256, patchId: fact(row.number).rebase.patchId, changedPaths: [path(row.number)], stagePaths: [], completePatch: "rebased full patch", byteLength: 18, tooLarge: false, clean: true, statusSha256: "clean", decision: "captured", summary: "landing candidate" },
    ]),
    solImplement: issues.flatMap((row) => [
      { ...meta(`i${row.number}:sol-implement`, 1), issueNumber: row.number, headSha: `prior-${row.number}`, diffSha256: `attempt-diff-${row.number}`, decision: "correct", changedPaths: [path(row.number)], summary: "corrected current feedback", acceptanceEvidence: ["focused regression"] },
      { ...meta(`i${row.number}:landing-sol-implement`, 2), issueNumber: row.number, headSha: fact(row.number).landingCandidate.headSha, diffSha256: fact(row.number).landingCandidate.diffSha256, decision: "correct", changedPaths: [path(row.number)], summary: "landing correction", acceptanceEvidence: ["prior landing failure"] },
    ]),
    protection: issues.flatMap((row) => [
      { ...meta(`i${row.number}:protection`, 1), issueNumber: row.number, headSha: fact(row.number).candidate.headSha, diffSha256: fact(row.number).candidate.diffSha256, passed: true, violations: [], changedPaths: [path(row.number)], stagePaths: [path(row.number)], tooLarge: false, decision: "pass", evidence: "complete working patch" },
      { ...meta(`i${row.number}:landing-protection`, 2), issueNumber: row.number, headSha: fact(row.number).landingCandidate.headSha, diffSha256: fact(row.number).landingCandidate.diffSha256, passed: true, violations: [], changedPaths: [path(row.number)], stagePaths: [path(row.number)], tooLarge: false, decision: "pass", evidence: "landing patch" },
    ]),
    lunaProposal: issues.flatMap((row) => [
      { ...meta(`i${row.number}:luna-proposal`, 1), ...fact(row.number).candidateProposal },
      { ...meta(`i${row.number}:landing-luna-proposal`, 2), ...fact(row.number).landingProposal },
      { ...meta(`i${row.number}:publication-luna-proposal`, 2), ...fact(row.number).publicationProposal },
    ]),
    commitProof: issues.flatMap((row) => [
      { ...meta(`i${row.number}:commit`, 1), ...fact(row.number).candidateCommit },
      { ...meta(`i${row.number}:landing-amend`, 2), ...fact(row.number).landingCommit },
    ]),
    fableReview: issues.flatMap((row) => [
      { ...meta(`i${row.number}:fable-review`, 1), issueNumber: row.number, headSha: fact(row.number).candidateCommit.headSha, diffSha256: fact(row.number).candidateCommit.diffSha256, decision: "approve", approved: true, findings: [], acceptanceEvidence: ["candidate exact"], summary: "candidate approved" },
      { ...meta(`i${row.number}:landing-review`, 2), issueNumber: row.number, headSha: fact(row.number).rebase.headSha, diffSha256: fact(row.number).rebase.diffSha256, decision: "approve", approved: true, findings: [], acceptanceEvidence: ["rebased exact"], summary: "landing approved" },
    ]),
    evidenceCheck: issues.flatMap((row) => [
      { ...meta(`i${row.number}:review-check`, 1), issueNumber: row.number, headSha: fact(row.number).candidateCommit.headSha, diffSha256: fact(row.number).candidateCommit.diffSha256, passed: true, protectedPathClean: true, clean: true, decision: "bound", summary: "candidate bound" },
      { ...meta(`i${row.number}:landing-review-check`, 2), issueNumber: row.number, headSha: fact(row.number).rebase.headSha, diffSha256: fact(row.number).rebase.diffSha256, passed: true, protectedPathClean: true, clean: true, decision: "bound", summary: "landing bound" },
    ]),
    gates: issues.flatMap((row) => [
      { ...meta(`i${row.number}:candidate-gates`, 1), issueNumber: row.number, headSha: fact(row.number).candidateCommit.headSha, diffSha256: fact(row.number).candidateCommit.diffSha256, passed: true, commands: [command(["pnpm", "-C", "packages/components", "test"]), command(["pnpm", "typecheck"]), command(["pnpm", "test"])], beforeStatusSha256: "clean", afterStatusSha256: "clean", unchanged: true, decision: "pass", summary: "candidate green" },
      { ...meta(`i${row.number}:landing-gates`, 2), issueNumber: row.number, headSha: fact(row.number).rebase.headSha, diffSha256: fact(row.number).rebase.diffSha256, passed: true, commands: [command(["pnpm", "-C", "packages/components", "test"]), command(["pnpm", "typecheck"]), command(["pnpm", "test"])], beforeStatusSha256: "clean", afterStatusSha256: "clean", unchanged: true, decision: "pass", summary: "landing green" },
      { ...meta(`i${row.number}:landing-gates`, 1), issueNumber: row.number, headSha: fact(row.number).candidateCommit.headSha, diffSha256: fact(row.number).candidateCommit.diffSha256, passed: false, commands: [{ ...command(["pnpm", "test"]), exitCode: 1, passed: false }], beforeStatusSha256: "clean", afterStatusSha256: "clean", unchanged: true, decision: "fail", summary: "prior landing failed" },
    ]),
    laneReadiness: issues.map((row) => ({ ...meta(`i${row.number}:lane-readiness`, 1), issueNumber: row.number, issueIdentitySha256: row.identitySha256, headSha: fact(row.number).candidateCommit.headSha, diffSha256: fact(row.number).candidateCommit.diffSha256, patchId: fact(row.number).candidateCommit.patchId, changedPaths: [path(row.number)], envelope: [path(row.number)], approvalIteration: 1, sourceCommitProofId: fact(row.number).candidateCommit.proofId, ready: true, attempt: 2, decision: "ready", feedback: ["ready evidence"], summary: "ready" })),
    landingRefresh: issues.map((row) => ({ ...meta(`i${row.number}:landing-refresh`, 2), issueNumber: row.number, sourceCommitProofId: fact(row.number).landingCommit.proofId, approvalIteration: 2, envelope: [path(row.number)], commitMessageSha256: sha256(messageFor(row.number)), ready: true, collisionEvidenceOk: true, canonicalOrigin: true, originUrl: "https://github.com/smithersai/smithers.git", pushUrl: "git@github.com:smithersai/smithers.git", fetchExitCode: 0, issueOpen: true, identityMatches: true, issueIdentitySha256: row.identitySha256, oldBaseSha: "base", newBaseSha: "base2", headSha: fact(row.number).landingCommit.headSha, diffSha256: fact(row.number).landingCommit.diffSha256, statusSha256: "clean", patchId: fact(row.number).landingCommit.patchId, changedPaths: [path(row.number)], matchingFixesCommits: [], equivalentCommits: [], alreadyReachable: false, consistentReachability: false, decision: "rebase", evidence: ["fresh"], summary: "fresh landing" })),
    rebaseProof: issues.map((row) => ({ ...meta(`i${row.number}:rebase`, 2), ...fact(row.number).rebase })),
    publication: issues.map((row) => ({ ...meta(`i${row.number}:publication`, 2), ...fact(row.number).publication })),
    closureRefresh: issues.map((row) => ({ ...meta(`i${row.number}:closure-refresh`), ...fact(row.number).closureRefresh })),
    closeProposal: issues.map((row) => ({ ...meta(`i${row.number}:close-proposal`), ...fact(row.number).closeProposal })),
  };
}

describe("riskless GitHub issue sweep production graph", () => {
  test("renders frame zero with concrete table schemas and null runtime defaults", async () => {
    const frame = await renderWorkflow(workflow, { input: { repo: null, excludeNumbers: null, laneConcurrency: null, reviewIterations: null, landingRetries: null, dryRun: null, conservativeLabelHints: null, prompt: null }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(frame.tasks.map((task) => task.nodeId)).toEqual(["normalize-inputs"]); expect(frame.tasks[0].outputSchema).toBeDefined(); expect(frame.tasks[0].outputTable).toBeDefined();
    await expect(runTask(frame.tasks[0])).resolves.toMatchObject({ laneConcurrency: 16, reviewIterations: 3, landingRetries: 3, excludeNumbers: [] });
  });

  test("renders two concrete current-iteration correction lanes and one complete serial landing queue", async () => {
    const outputs = lateOutputs(); const iterations = { "i42:correction-loop": 1, "i43:correction-loop": 1, "i42:landing-loop": 2, "i43:landing-loop": 2 };
    const frame = await renderWorkflow(workflow, { input, outputs, iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    const expectedAgents = ["i42:classify", "i42:adjudicate", "i42:sol-implement", "i42:luna-proposal", "i42:fable-review", "i42:landing-sol-implement", "i42:landing-luna-proposal", "i42:landing-review", "i42:close-proposal", "i43:classify", "i43:adjudicate", "i43:sol-implement", "i43:luna-proposal", "i43:fable-review", "i43:landing-sol-implement", "i43:landing-luna-proposal", "i43:landing-review"];
    for (const id of expectedAgents) expect(frame.tasks.some((task) => task.nodeId === id && typeof (Array.isArray(task.agent) ? task.agent[0] : task.agent)?.generate === "function")).toBe(true);
    for (const task of frame.tasks.filter((candidate) => candidate.agent)) {
      const agents: any[] = Array.isArray(task.agent) ? task.agent : [task.agent];
      expect(agents.every((candidate) => typeof candidate?.generate === "function")).toBe(true);
      const agent = agents[0];
      if (task.nodeId.includes("fable-review") || task.nodeId.includes("landing-review")) expect(agent.model).toBe("claude-fable-5");
      if (task.nodeId.includes("classify") || task.nodeId.includes("sol-implement")) expect(agent.model).toBe("gpt-5.6-sol");
      if (task.nodeId.includes("adjudicate") || task.nodeId.includes("luna-proposal") || task.nodeId.includes("close-proposal")) expect(agent.model).toBe("gpt-5.6-luna");
    }
    let nested = false; let mergeQueues = 0; walk(frame.xml, (node, depth) => { const tag = String(node.tag ?? node.name ?? node.type ?? "").toLowerCase(); if ((tag.includes("loop") || tag.includes("ralph")) && depth > 1) nested = true; if (tag.includes("mergequeue") || tag.includes("merge-queue")) mergeQueues++; });
    expect(nested).toBe(false); expect(mergeQueues).toBe(1);
    const landingSeed = frame.tasks.find((task) => task.nodeId === "i42:landing-refresh")!; const landing = frame.tasks.filter((task) => task.parallelGroupId === landingSeed.parallelGroupId); const phases = ["landing-correction-evidence", "landing-sol-implement", "landing-protection", "landing-luna-proposal", "landing-amend", "landing-refresh", "rebase", "landing-evidence", "landing-review", "landing-review-check", "landing-gates", "publication-luna-proposal", "publication", "closure-refresh", "closure"];
    const expectedLanding = [42, 43].flatMap((number) => phases.map((phase) => `i${number}:${phase}`)).concat("i42:close-proposal").sort(); expect(landing.map((task) => task.nodeId).sort()).toEqual(expectedLanding); expect(new Set(landing.map((task) => task.parallelGroupId)).size).toBe(1); expect(landing.every((task) => task.parallelMaxConcurrency === 1)).toBe(true);
  });

  test("does not mount closure mutation without current publication and fresh comment enumeration", async () => {
    const outputs: any = lateOutputs(); outputs.publication = []; outputs.closureRefresh = []; outputs.closeProposal = [];
    const frame = await renderWorkflow(workflow, { input, outputs, iterations: { "i42:correction-loop": 1, "i43:correction-loop": 1, "i42:landing-loop": 2, "i43:landing-loop": 2 }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(frame.tasks.some((task) => /:(closure-refresh|close-proposal|closure)$/.test(task.nodeId))).toBe(false);
    const failedEnumeration: any = lateOutputs(); failedEnumeration.closureRefresh = failedEnumeration.closureRefresh.map((row: any) => ({ ...row, ready: false, commentsEnumerated: false, decision: "defer" })); failedEnumeration.closeProposal = [];
    const blocked = await renderWorkflow(workflow, { input, outputs: failedEnumeration, iterations: { "i42:correction-loop": 1, "i43:correction-loop": 1, "i42:landing-loop": 2, "i43:landing-loop": 2 }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(blocked.tasks.some((task) => /:(close-proposal|closure)$/.test(task.nodeId))).toBe(false);
  });

  test("does not mount publication when Luna explicitly defers despite valid=true", async () => {
    const outputs: any = lateOutputs(); outputs.publication = []; outputs.lunaProposal = outputs.lunaProposal.map((row: any) => row.nodeId.endsWith(":publication-luna-proposal") ? { ...row, valid: true, decision: "defer" } : row);
    const frame = await renderWorkflow(workflow, { input, outputs, iterations: { "i42:correction-loop": 1, "i43:correction-loop": 1, "i42:landing-loop": 2, "i43:landing-loop": 2 }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(frame.tasks.some((task) => task.nodeId === "i42:publication")).toBe(false);
    expect(frame.tasks.some((task) => task.nodeId === "i43:publication")).toBe(false);
  });

  test("terminalizes absent or invalid Luna closure output and preserves fail-closed rebase paths", async () => {
    const absent: any = lateOutputs(); absent.closeProposal = []; absent.closure = [];
    const absentFrame = await renderWorkflow(workflow, { input, outputs: absent, iterations: { "i42:correction-loop": 1, "i43:correction-loop": 1, "i42:landing-loop": 2, "i43:landing-loop": 2, "i42:closure-loop": 2, "i43:closure-loop": 2 }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(absentFrame.tasks.some((task) => task.nodeId === "i42:terminal")).toBe(true);
    expect(absentFrame.tasks.some((task) => task.nodeId === "i42:closure")).toBe(false);
    const invalid: any = lateOutputs(); invalid.closeProposal = invalid.closeProposal.map((row: any) => ({ ...row, issueNumber: 999 })); invalid.closure = [];
    const invalidFrame = await renderWorkflow(workflow, { input, outputs: invalid, iterations: { "i42:correction-loop": 1, "i43:correction-loop": 1, "i42:landing-loop": 2, "i43:landing-loop": 2, "i42:closure-loop": 2, "i43:closure-loop": 2 }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(invalidFrame.tasks.some((task) => task.nodeId === "i42:terminal")).toBe(true);
    expect(invalidFrame.tasks.some((task) => task.nodeId === "i42:closure")).toBe(false);
    const dropped: any = lateOutputs(); dropped.rebaseProof = dropped.rebaseProof.map((row: any) => ({ ...row, exactChangedPaths: false })); dropped.candidateEvidence = dropped.candidateEvidence.filter((row: any) => !row.nodeId.endsWith(":landing-evidence"));
    const droppedFrame = await renderWorkflow(workflow, { input, outputs: dropped, iterations: { "i42:correction-loop": 1, "i43:correction-loop": 1, "i42:landing-loop": 2, "i43:landing-loop": 2 }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(droppedFrame.tasks.some((task) => task.nodeId === "i42:landing-evidence")).toBe(false);
  });

  test("failed deterministic commit proposal restores a clean exact HEAD and index", () => {
    const fixture = mkdtempSync(join(tmpdir(), "riskless-commit-"));
    const git = (...args: string[]) => spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
    try {
      expect(git("init", "-q").status).toBe(0); expect(git("config", "user.name", "Test").status).toBe(0); expect(git("config", "user.email", "test@example.com").status).toBe(0);
      writeFileSync(join(fixture, ".gitignore"), "ignored.poison\n"); writeFileSync(join(fixture, "file.txt"), "base\n"); expect(git("add", "--", ".gitignore", "file.txt").status).toBe(0); expect(git("commit", "-qm", "base").status).toBe(0);
      const base = git("rev-parse", "HEAD").stdout.trim(); writeFileSync(join(fixture, "file.txt"), "candidate\n"); expect(git("add", "--", "file.txt").status).toBe(0); writeFileSync(join(fixture, "untracked.poison"), "poison\n"); writeFileSync(join(fixture, "ignored.poison"), "poison\n");
      const result = commitCandidate(42, "identity-42", base, fixture, { issueNumber: 42, issueIdentitySha256: "identity-42", baseSha: base, headSha: base, diffSha256: "wrong", patchId: "wrong", approvalPhase: "candidate-commit", sourceProofId: "wrong", approvalIteration: 0, envelope: ["file.txt"], decision: "propose", valid: true, stagePaths: ["file.txt"], changedPaths: ["file.txt"], commitMessage: "🐛 fix: candidate\n\nFixes #42\nCo-Authored-By: Test <test@example.com>" }, "candidate-commit", 0, ["file.txt"]);
      expect(result.decision).toBe("reject"); expect(result.clean).toBe(true); expect(git("rev-parse", "HEAD").stdout.trim()).toBe(base); expect(git("status", "--porcelain", "--ignored=matching").stdout).toBe("");
    } finally { rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 30_000);

  test("successful commit removes ignored residue and preserves the exact committed tuple", () => {
    const fixture = mkdtempSync(join(tmpdir(), "riskless-commit-success-")); const git = (...args: string[]) => spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
    try {
      expect(git("init", "-q").status).toBe(0); expect(git("config", "user.name", "Test").status).toBe(0); expect(git("config", "user.email", "test@example.com").status).toBe(0); writeFileSync(join(fixture, ".gitignore"), "artifact.tmp\n"); writeFileSync(join(fixture, "file.txt"), "base\n"); expect(git("add", ".gitignore", "file.txt").status).toBe(0); expect(git("commit", "-qm", "base").status).toBe(0); const base = git("rev-parse", "HEAD").stdout.trim(); writeFileSync(join(fixture, "file.txt"), "candidate\n"); expect(git("add", "--", "file.txt").status).toBe(0); writeFileSync(join(fixture, "artifact.tmp"), "residue\n"); const patch = git("diff", "--binary", "--full-index", "--no-ext-diff", base, "--").stdout; const patchId = spawnSync("git", ["patch-id", "--stable"], { cwd: fixture, input: patch, encoding: "utf8" }).stdout.trim().split(/\s+/)[0]; const message = "🐛 fix: candidate\n\nFixes #42\nCo-Authored-By: Test <test@example.com>"; const candidate = { baseSha: base, headSha: base, diffSha256: sha256(patch), patchId, changedPaths: ["file.txt"], stagePaths: ["file.txt"] };
      const proposal = { issueNumber: 42, issueIdentitySha256: "identity-42", baseSha: base, headSha: base, diffSha256: candidate.diffSha256, patchId, approvalPhase: "candidate-commit", sourceProofId: candidateProofId({ number: 42, identitySha256: "identity-42" }, candidate, ["file.txt"], "candidate-commit", 0), approvalIteration: 0, decision: "propose", valid: true, stagePaths: ["file.txt"], changedPaths: ["file.txt"], envelope: ["file.txt"], commitMessage: message };
      const result = commitCandidate(42, "identity-42", base, fixture, proposal, "candidate-commit", 0, ["file.txt"]);
      expect(result.decision).toBe("committed"); expect(result.proofId).toBe(commitProofId(result)); expect(result.sourceApprovalId).toBe(lunaApprovalId(proposal)); expect(result.changedPaths).toEqual(["file.txt"]); expect(git("status", "--porcelain", "--ignored=matching").stdout).toBe(""); expect(git("log", "-1", "--format=%B").stdout.trimEnd()).toBe(message);
    } finally { rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 30_000);

  test("disables repository hooks while creating the Luna-approved commit", () => {
    const fixture = mkdtempSync(join(tmpdir(), "riskless-commit-hook-")); const git = (...args: string[]) => spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
    try {
      expect(git("init", "-q").status).toBe(0); expect(git("config", "user.name", "Test").status).toBe(0); expect(git("config", "user.email", "test@example.com").status).toBe(0); writeFileSync(join(fixture, "file.txt"), "base\n"); expect(git("add", "--", "file.txt").status).toBe(0); expect(git("commit", "-qm", "base").status).toBe(0); const base = git("rev-parse", "HEAD").stdout.trim(); writeFileSync(join(fixture, "file.txt"), "candidate\n"); expect(git("add", "--", "file.txt").status).toBe(0); const patch = git("diff", "--binary", "--full-index", "--no-ext-diff", base, "--").stdout; const patchId = spawnSync("git", ["patch-id", "--stable"], { cwd: fixture, input: patch, encoding: "utf8" }).stdout.trim().split(/\s+/)[0]; const message = "🐛 fix: candidate\n\nFixes #42\nCo-Authored-By: Test <test@example.com>"; const candidate = { baseSha: base, headSha: base, diffSha256: sha256(patch), patchId, changedPaths: ["file.txt"], stagePaths: ["file.txt"] }; const proposal = { issueNumber: 42, issueIdentitySha256: "identity-42", baseSha: base, headSha: base, diffSha256: candidate.diffSha256, patchId, approvalPhase: "candidate-commit", sourceProofId: candidateProofId({ number: 42, identitySha256: "identity-42" }, candidate, ["file.txt"], "candidate-commit", 0), approvalIteration: 0, decision: "propose", valid: true, stagePaths: ["file.txt"], changedPaths: ["file.txt"], envelope: ["file.txt"], commitMessage: message };
      const hook = join(fixture, ".git", "hooks", "pre-commit"); writeFileSync(hook, "#!/bin/sh\nprintf 'hook mutation\\n' >> file.txt\ngit add -- file.txt\n"); chmodSync(hook, 0o755);
      const result = commitCandidate(42, "identity-42", base, fixture, proposal, "candidate-commit", 0, ["file.txt"]);
      expect(result.decision).toBe("committed"); expect(result.proofId).toBe(commitProofId(result)); expect(result.clean).toBe(true); expect(git("rev-parse", "HEAD").stdout.trim()).not.toBe(base); expect(readFileSync(join(fixture, "file.txt"), "utf8")).toBe("candidate\n"); expect(git("status", "--porcelain", "--ignored=matching").stdout).toBe("");
    } finally { rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 30_000);

  test("ignores stale correction and landing rows for immediate authorization", async () => {
    const outputs = lateOutputs();
    const frame = await renderWorkflow(workflow, { input, outputs, iterations: { "i42:correction-loop": 2, "i43:correction-loop": 2, "i42:landing-loop": 3, "i43:landing-loop": 3 }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(frame.tasks.some((task) => /^i(42|43):(landing-refresh|publication|closure)$/.test(task.nodeId))).toBe(false);
    expect(frame.tasks.some((task) => task.nodeId === "i42:attempt-evidence")).toBe(true);
    expect(frame.tasks.some((task) => task.nodeId === "i43:attempt-evidence")).toBe(true);
  });

  test("rejects reordered or stale causal proofs before each downstream authority", async () => {
    const iterations = { "i42:correction-loop": 1, "i43:correction-loop": 1, "i42:landing-loop": 2, "i43:landing-loop": 2 };
    const baseline = await renderWorkflow(workflow, { input, outputs: lateOutputs(), iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(baseline.tasks.some((task) => task.nodeId === "i42:landing-refresh")).toBe(true);
    expect(baseline.tasks.some((task) => task.nodeId === "i42:publication")).toBe(true);
    expect(baseline.tasks.some((task) => task.nodeId === "i42:closure")).toBe(true);

    const staleCommit: any = lateOutputs(); staleCommit.commitProof = staleCommit.commitProof.map((row: any) => row.nodeId === "i42:landing-amend" ? { ...row, proofId: "stale-commit-proof" } : row);
    const staleCommitFrame = await renderWorkflow(workflow, { input, outputs: staleCommit, iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(staleCommitFrame.tasks.some((task) => task.nodeId === "i42:landing-refresh")).toBe(false);

    const staleRebase: any = lateOutputs(); staleRebase.rebaseProof = staleRebase.rebaseProof.map((row: any) => row.issueNumber === 42 ? { ...row, proofId: "stale-rebase-proof" } : row);
    const staleRebaseFrame = await renderWorkflow(workflow, { input, outputs: staleRebase, iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(staleRebaseFrame.tasks.some((task) => task.nodeId === "i42:landing-evidence")).toBe(false);
    expect(staleRebaseFrame.tasks.some((task) => task.nodeId === "i42:publication-luna-proposal")).toBe(false);

    const staleProposal: any = lateOutputs(); staleProposal.publication = []; staleProposal.lunaProposal = staleProposal.lunaProposal.map((row: any) => row.nodeId === "i42:publication-luna-proposal" ? { ...row, sourceProofId: "stale-rebase-proof" } : row);
    const staleProposalFrame = await renderWorkflow(workflow, { input, outputs: staleProposal, iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(staleProposalFrame.tasks.some((task) => task.nodeId === "i42:publication")).toBe(false);

    const stalePublication: any = lateOutputs(); stalePublication.publication = stalePublication.publication.map((row: any) => row.issueNumber === 42 ? { ...row, proofId: "stale-publication-proof" } : row);
    const stalePublicationFrame = await renderWorkflow(workflow, { input, outputs: stalePublication, iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(stalePublicationFrame.tasks.some((task) => task.nodeId === "i42:closure-refresh")).toBe(false);

    const staleClosure: any = lateOutputs(); staleClosure.closureRefresh = staleClosure.closureRefresh.map((row: any) => row.issueNumber === 42 ? { ...row, proofId: "stale-closure-refresh" } : row);
    const staleClosureFrame = await renderWorkflow(workflow, { input, outputs: staleClosure, iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(staleClosureFrame.tasks.some((task) => task.nodeId === "i42:close-proposal")).toBe(false);
    expect(staleClosureFrame.tasks.some((task) => task.nodeId === "i42:closure")).toBe(false);

    expect(risklessProofId("commit-proof", ["same"])).not.toBe(risklessProofId("publication-proof", ["same"]));
    expect(risklessProofId("commit-proof", ["a", "b"])).not.toBe(risklessProofId("commit-proof", ["b", "a"]));
  });

  test("dry-run never mounts sync, worktree, implementation, landing, publication, or closure tasks", async () => {
    const frame = await renderWorkflow(workflow, { input: { ...input, dryRun: true }, outputs: { normalizeInputs: [{ ...meta("normalize-inputs"), valid: true, ...input, dryRun: true, protectedPaths: [], summary: "dry" }] }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(frame.tasks.map((task) => task.nodeId)).toEqual(["normalize-inputs", "verify-checkout"]); expect(frame.tasks.some((task) => /synchronize|discover|bootstrap|sol-implement|rebase|publication|closure|final-sync/.test(task.nodeId))).toBe(false);
  });

  test("validates exact target-only messages, canonical fetch/push URLs, and focused argv coverage", () => {
    expect(exactCommitMessage("🐛 fix(core): repair\n\nFixes #42\nCo-Authored-By: Codex <codex@example.com>", 42)).toBe(true);
    expect(exactCommitMessage("📝 docs: repair typo\n\nFixes #42\nCo-Authored-By: Codex <codex@example.com>", 42)).toBe(true);
    expect(exactCommitMessage("🐛 fix: repair\n\nFixes #42\nCloses #43\nCo-Authored-By: Codex <codex@example.com>", 42)).toBe(false);
    expect(exactCommitMessage("🚀 fix: repair\n\nFixes #42\nCo-Authored-By: Codex <codex@example.com>", 42)).toBe(false);
    expect(canonicalGithubRemote("https://github.com/smithersai/smithers.git")).toBe(true); expect(canonicalGithubRemote("git@evil.example:smithersai/smithers.git")).toBe(false);
    const root = join(import.meta.dir, "../..");
    expect(focusedCommands(root, ["packages/components/package.json"])[0]).toEqual(["pnpm", "-C", "packages/components", "test"]);
    expect(focusedCommands(root, ["apps/review/package.json"])[0]).toEqual(["pnpm", "-C", "apps/review", "test"]);
    expect(focusedCommands(root, ["docs/index.mdx"]).some((argv) => argv.join(" ") === "pnpm check:docs")).toBe(true);
    expect(focusedCommands(root, ["scripts/check-docs.mjs"])[0]).toEqual(["node", "--check", "scripts/check-docs.mjs"]);
    expect(focusedCommands(root, ["package.json"])[0]).toEqual(["pnpm", "check:deps"]);
    expect(focusedCommands(root, ["packages/components/package.json"]).some((argv) => argv[1]?.startsWith("-Cpackages"))).toBe(false);
    const fixture = mkdtempSync(join(tmpdir(), "riskless-focused-"));
    try {
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test", "check:docs": "docs", "check:llms": "llms", "check:deps": "deps" } })); mkdirSync(join(fixture, "packages/new-root"), { recursive: true }); writeFileSync(join(fixture, "packages/new-root/package.json"), "{}");
      expect(() => focusedCommands(fixture, ["packages/new-root/package.json"])).toThrow("no deterministic test/typecheck");
      writeFileSync(join(fixture, "packages/new-root/package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } })); expect(focusedCommands(fixture, ["packages/new-root/package.json"])[0]).toEqual(["pnpm", "-C", "packages/new-root", "typecheck"]);
      expect(focusedCommands(fixture, ["packages/deleted/package.json"])[0]).toEqual(["pnpm", "typecheck"]);
      expect(focusedCommands(fixture, ["scripts/deleted.mjs"])[0]).toEqual(["pnpm", "typecheck"]);
    } finally { rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });

  test("binds Sol and Luna only to a private outside-workspace Codex auth directory", () => {
    const fixture = mkdtempSync(join(tmpdir(), "riskless-codex-config-"));
    const workspace = join(fixture, "workspace");
    const config = join(fixture, "codex");
    mkdirSync(workspace); mkdirSync(config, { mode: 0o700 });
    const auth = join(config, "auth.json");
    try {
      writeFileSync(auth, "{}", { mode: 0o600 });
      if (process.platform === "win32") {
        expect(pinnedCodexConfigDirectory(config, workspace)).toBe("");
      } else {
        expect(canonicalAncestorsSecure(config)).toBe(true);
        expect(canonicalAncestorsSecure(config, Number.MAX_SAFE_INTEGER)).toBe(false);
        expect(pinnedCodexConfigDirectory(config, workspace)).toBe(realpathSync(config));
        chmodSync(auth, 0o644);
        expect(pinnedCodexConfigDirectory(config, workspace)).toBe("");
        chmodSync(auth, 0o600);
      }
      expect(pinnedCodexConfigDirectory("relative/codex", workspace)).toBe("");
      const inside = join(workspace, "codex"); mkdirSync(inside, { mode: 0o700 }); writeFileSync(join(inside, "auth.json"), "{}", { mode: 0o600 });
      expect(pinnedCodexConfigDirectory(inside, workspace)).toBe("");
      if (process.platform !== "win32") {
        const unsafeParent = join(fixture, "unsafe-parent"); const nestedConfig = join(unsafeParent, "codex");
        mkdirSync(nestedConfig, { recursive: true, mode: 0o700 }); chmodSync(unsafeParent, 0o777); writeFileSync(join(nestedConfig, "auth.json"), "{}", { mode: 0o600 });
        expect(pinnedCodexConfigDirectory(nestedConfig, workspace)).toBe("");
        rmSync(auth); symlinkSync(join(inside, "auth.json"), auth);
        expect(pinnedCodexConfigDirectory(config, workspace)).toBe("");
      }
    } finally { rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });

  test("pins GitHub mutations and rejects ambiguous remotes and non-exact remote tips", () => {
    const fixture = mkdtempSync(join(tmpdir(), "riskless-pinned-boundaries-")); const git = (...args: string[]) => spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
    try {
      expect(git("init", "-q").status).toBe(0); expect(git("config", "user.name", "Test").status).toBe(0); expect(git("config", "user.email", "test@example.com").status).toBe(0);
      writeFileSync(join(fixture, "x.txt"), "base\n"); expect(git("add", "--", "x.txt").status).toBe(0); expect(git("commit", "-qm", "base").status).toBe(0); const base = git("rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(fixture, "x.txt"), "descendant\n"); expect(git("commit", "-qam", "descendant").status).toBe(0); const descendant = git("rev-parse", "HEAD").stdout.trim();
      expect(git("revert", "--no-edit", descendant).status).toBe(0); const reverted = git("rev-parse", "HEAD").stdout.trim();
      expect(exactRemoteTipProven(descendant, descendant, descendant)).toBe(true); expect(exactRemoteTipProven(base, descendant, descendant)).toBe(false); expect(exactRemoteTipProven(descendant, reverted, reverted)).toBe(false); expect(exactRemoteTipProven(descendant, descendant, reverted)).toBe(false);

      expect(git("remote", "add", "origin", "https://github.com/smithersai/smithers.git").status).toBe(0); expect(git("remote", "set-url", "--add", "origin", "https://evil.example/smithersai/smithers.git").status).toBe(0); expect(git("remote", "set-url", "--add", "--push", "origin", "git@github.com:smithersai/smithers.git").status).toBe(0); expect(git("remote", "set-url", "--add", "--push", "origin", "git@evil.example:smithersai/smithers.git").status).toBe(0);
      const remote = canonicalRemoteConfiguration(fixture); expect(remote.ok).toBe(false); expect(remote.fetchUrls).toHaveLength(2); expect(remote.pushUrls).toHaveLength(2); expect(fetchCanonicalMain(fixture).ok).toBe(false); expect(pushCanonicalMain(fixture, descendant).ok).toBe(false);

      expect(pinnedGithubArgv(["api", "repos/smithersai/smithers/issues/42"])).toEqual(["gh", "api", "--hostname", "github.com", "repos/smithersai/smithers/issues/42"]); expect(() => pinnedGithubArgv(["api", "https://evil.example/repos/smithersai/smithers/issues/42"])).toThrow(); expect(() => pinnedGithubArgv(["issue", "close", "42", "--repo=evil/repo"])).toThrow();
      expect(pinnedGithubEnvironment({ GH_HOST: "evil.example", GH_REPO: "evil/repo" })).toMatchObject({ GH_HOST: "github.com", GH_REPO: "github.com/smithersai/smithers" });
      const bin = join(fixture, "bin"); const ghConfig = join(fixture, "gh-config"); const recorder = join(fixture, "gh-record"); mkdirSync(bin); mkdirSync(ghConfig, { mode: 0o700 }); writeFileSync(join(ghConfig, "config.yml"), "", { mode: 0o600 }); writeFileSync(join(ghConfig, "hosts.yml"), "", { mode: 0o600 }); const fakeGh = join(bin, "gh"); writeFileSync(fakeGh, `#!/bin/sh\nif [ "$1" = config ]; then printf '%s' "\${FAKE_GH_SOCKET:-}"; exit 0; fi\nprintf '%s\\n' "$GH_HOST" "$GH_REPO" "$@" > "$RECORDER"\nprintf '{}\\n'\n`); chmodSync(fakeGh, 0o755);
      const sourceEnv = { PATH: `${bin}:/usr/bin:/bin`, GH_CONFIG_DIR: ghConfig, GH_HOST: "evil.example", GH_REPO: "evil/repo", RECORDER: recorder };
      expect(pinnedGithubConfiguration(fixture, sourceEnv).ok).toBe(true);
      const api = runPinnedGithub(["api", "repos/smithersai/smithers/issues/42"], fixture, sourceEnv); expect(api.ok).toBe(true); expect(readFileSync(recorder, "utf8").split(/\r?\n/).slice(0, 5)).toEqual(["github.com", "github.com/smithersai/smithers", "api", "--hostname", "github.com"]);
      const close = runPinnedGithub(["issue", "close", "42"], fixture, sourceEnv); expect(close.ok).toBe(true); const recorded = readFileSync(recorder, "utf8"); expect(recorded).toContain("github.com\ngithub.com/smithersai/smithers\nissue\nclose\n42\n--repo\ngithub.com/smithersai/smithers\n"); expect(recorded).not.toContain("evil.example");
      if (process.platform !== "win32") {
        const unsafeParent = join(fixture, "unsafe-gh-parent"); const unsafeConfig = join(unsafeParent, "config"); mkdirSync(unsafeConfig, { recursive: true, mode: 0o700 }); chmodSync(unsafeParent, 0o777); writeFileSync(join(unsafeConfig, "config.yml"), "", { mode: 0o600 }); writeFileSync(join(unsafeConfig, "hosts.yml"), "", { mode: 0o600 });
        expect(pinnedGithubConfiguration(fixture, { ...sourceEnv, GH_CONFIG_DIR: unsafeConfig }).ok).toBe(false);
      }
      const socketEnv = { ...sourceEnv, FAKE_GH_SOCKET: join(fixture, "attacker.sock") }; expect(pinnedGithubConfiguration(fixture, socketEnv).ok).toBe(false); expect(runPinnedGithub(["issue", "close", "42"], fixture, socketEnv).ok).toBe(false); expect(readFileSync(recorder, "utf8")).toBe(recorded);
    } finally { rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 30_000);

  test("rejects empty admission envelopes and missing role rows with explicit evidence", async () => {
    const outputs: any = lateOutputs(); outputs.classify = outputs.classify.map((row: any) => ({ ...row, likelyPaths: [] })); outputs.adjudicate = outputs.adjudicate.map((row: any) => ({ ...row, likelyPaths: [] })); outputs.admissionLedger = [];
    const frame = await renderWorkflow(workflow, { input, outputs, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" }); const ledgerTask = frame.tasks.find((task) => task.nodeId === "admission-ledger"); expect(ledgerTask).toBeDefined();
    const ledger: any = await runTask(ledgerTask!); expect(ledger.valid).toBe(false); expect(ledger.admittedIssueNumbers).toEqual([]); expect(ledger.dispositions.every((row: any) => row.missingRoles.length === 2)).toBe(true);
    const missing: any = lateOutputs(); missing.adjudicate = missing.adjudicate.filter((row: any) => row.issueNumber !== 43); missing.admissionLedger = [];
    const missingFrame = await renderWorkflow(workflow, { input, outputs: missing, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" }); const missingLedger: any = await runTask(missingFrame.tasks.find((task) => task.nodeId === "admission-ledger")!); expect(missingLedger.valid).toBe(false); expect(missingLedger.dispositions.find((row: any) => row.issueNumber === 43).missingRoles).toContain("adjudicator");
    const mismatch: any = lateOutputs(); mismatch.adjudicate = mismatch.adjudicate.map((row: any) => row.issueNumber === 42 ? { ...row, likelyPaths: ["packages/components/src/broader.ts"] } : row); mismatch.admissionLedger = []; const mismatchFrame = await renderWorkflow(workflow, { input, outputs: mismatch, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" }); const mismatchLedger: any = await runTask(mismatchFrame.tasks.find((task) => task.nodeId === "admission-ledger")!); expect(mismatchLedger.admittedIssueNumbers).not.toContain(42); expect(mismatchLedger.dispositions.find((row: any) => row.issueNumber === 42).likelyPaths).toEqual([]);
    const broad: any = lateOutputs(); broad.classify = broad.classify.map((row: any) => row.issueNumber === 42 ? { ...row, likelyPaths: ["packages/components/"] } : row); broad.adjudicate = broad.adjudicate.map((row: any) => row.issueNumber === 42 ? { ...row, likelyPaths: ["packages/components/"] } : row); broad.admissionLedger = []; const broadFrame = await renderWorkflow(workflow, { input, outputs: broad, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" }); const broadLedger: any = await runTask(broadFrame.tasks.find((task) => task.nodeId === "admission-ledger")!); expect(broadLedger.admittedIssueNumbers).not.toContain(42);
    const checkoutMismatch: any = lateOutputs(); checkoutMismatch.discoverIssues = checkoutMismatch.discoverIssues.map((row: any) => ({ ...row, classificationHeadSha: "different-checkout" })); checkoutMismatch.admissionLedger = []; const checkoutMismatchFrame = await renderWorkflow(workflow, { input, outputs: checkoutMismatch, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" }); const checkoutMismatchLedger: any = await runTask(checkoutMismatchFrame.tasks.find((task) => task.nodeId === "admission-ledger")!); expect(checkoutMismatchLedger.valid).toBe(false); expect(checkoutMismatchLedger.admittedIssueNumbers).toEqual([]); expect(checkoutMismatchLedger.summary).toContain("classification checkout");
  });

  test("defers historical Fixes commits instead of inheriting stale closure authority", async () => {
    const outputs: any = lateOutputs(); const sha = "a".repeat(40); outputs.liveRefresh = outputs.liveRefresh.map((row: any) => row.issueNumber === 42 ? { ...row, ready: false, matchingFixesCommits: [sha], recoveryCommitSha: "", recoveryDiffSha256: "", recoveryPatchId: "", recoveryChangedPaths: [], decision: "defer", summary: "historical Fixes commit requires careful handling" } : row); outputs.laneReadiness = outputs.laneReadiness.filter((row: any) => row.issueNumber !== 42); outputs.publication = outputs.publication.filter((row: any) => row.issueNumber !== 42); outputs.closureRefresh = outputs.closureRefresh.filter((row: any) => row.issueNumber !== 42); outputs.closeProposal = outputs.closeProposal.filter((row: any) => row.issueNumber !== 42);
    const frame = await renderWorkflow(workflow, { input, outputs, iterations: { "i42:correction-loop": 0, "i43:correction-loop": 1, "i42:landing-loop": 0, "i43:landing-loop": 2 }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" }); expect(frame.tasks.some((task) => /^i42:(sol-implement|luna-proposal|commit|publication|closure-refresh|close-proposal|closure)$/.test(task.nodeId))).toBe(false); expect(frame.tasks.some((task) => task.nodeId === "i42:terminal")).toBe(true);
  });

  test("recovers an ambiguously published exact commit without rebasing or pushing again", async () => {
    const prepareRetry = () => {
      const outputs: any = lateOutputs();
      outputs.normalizeInputs = outputs.normalizeInputs.map((row: any) => ({ ...row, landingRetries: 5 }));
      const rebase = outputs.rebaseProof.find((row: any) => row.issueNumber === 42);
      const priorPublication = outputs.publication.find((row: any) => row.issueNumber === 42);
      const failedPublication = { ...priorPublication, reachable: false, retryableRace: true, decision: "retry", summary: "push may have succeeded but verification was ambiguous" };
      failedPublication.proofId = publicationProofId(failedPublication);
      outputs.publication = outputs.publication.map((row: any) => row.issueNumber === 42 ? failedPublication : row);
      const priorRefresh = outputs.landingRefresh.find((row: any) => row.issueNumber === 42);
      const refresh = {
        ...priorRefresh,
        ...meta("i42:landing-refresh", 3),
        sourceCommitProofId: rebase.proofId,
        approvalIteration: 3,
        envelope: [...rebase.envelope],
        commitMessageSha256: rebase.commitMessageSha256,
        ready: false,
        oldBaseSha: rebase.newBaseSha,
        newBaseSha: rebase.headSha,
        headSha: rebase.headSha,
        diffSha256: rebase.diffSha256,
        patchId: rebase.patchId,
        changedPaths: [...rebase.changedPaths],
        matchingFixesCommits: [rebase.headSha],
        equivalentCommits: [rebase.headSha],
        alreadyReachable: true,
        consistentReachability: true,
        decision: "already-reachable",
        summary: "fresh exact ancestry and equivalence prove the ambiguous push landed",
      };
      outputs.landingRefresh.push(refresh);
      return { outputs, rebase, refresh };
    };
    const retryInput = { ...input, landingRetries: 5 };
    const iterations = { "i42:correction-loop": 1, "i43:correction-loop": 1, "i42:landing-loop": 3, "i43:landing-loop": 2 };
    const prepared = prepareRetry();
    const frame = await renderWorkflow(workflow, { input: retryInput, outputs: prepared.outputs, iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(frame.tasks.some((task) => task.nodeId === "i42:publication" && task.parallelMaxConcurrency === 1)).toBe(true);
    expect(frame.tasks.some((task) => task.nodeId === "i42:rebase")).toBe(false);

    const stale = prepareRetry(); stale.outputs.landingRefresh = stale.outputs.landingRefresh.map((row: any) => row.nodeId === "i42:landing-refresh" && row.iteration === 3 ? { ...row, sourceCommitProofId: "stale-proof" } : row);
    const staleFrame = await renderWorkflow(workflow, { input: retryInput, outputs: stale.outputs, iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(staleFrame.tasks.some((task) => task.nodeId === "i42:publication")).toBe(false);
    const reordered = prepareRetry(); reordered.outputs.landingRefresh = reordered.outputs.landingRefresh.map((row: any) => row.nodeId === "i42:landing-refresh" && row.iteration === 3 ? { ...row, changedPaths: [...row.changedPaths, row.changedPaths[0]] } : row);
    const reorderedFrame = await renderWorkflow(workflow, { input: retryInput, outputs: reordered.outputs, iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(reorderedFrame.tasks.some((task) => task.nodeId === "i42:publication")).toBe(false);

    const invalidPrior = prepareRetry(); const invalidPublication = invalidPrior.outputs.publication.find((row: any) => row.issueNumber === 42); Object.assign(invalidPublication, { reachable: true, decision: "published", canonicalOrigin: false, retryableRace: false }); invalidPublication.proofId = publicationProofId(invalidPublication);
    const invalidPriorFrame = await renderWorkflow(workflow, { input: retryInput, outputs: invalidPrior.outputs, iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(invalidPriorFrame.tasks.some((task) => task.nodeId === "i42:publication")).toBe(true);

    const recovered = prepareRetry(); const { rebase } = recovered; const issue42 = issue(42);
    const proposal = recovered.outputs.lunaProposal.find((row: any) => row.issueNumber === 42 && row.nodeId === "i42:publication-luna-proposal"); const landingApprovalId = lunaApprovalId(proposal);
    const liveState = { provenanceKind: "recovery", sourceRebaseProofId: rebase.proofId, landingApprovalId, issueNumber: 42, issueIdentitySha256: issue42.identitySha256, remoteSha: rebase.headSha, lsRemoteSha: rebase.headSha, issueState: "open", liveIssueIdentitySha256: issue42.identitySha256, canonicalOrigin: true, collisionOk: true, collisions: [], fixes: [rebase.headSha], equivalents: [rebase.headSha], queriesOk: true, clean: true, commitSha: rebase.headSha, parentSha: rebase.newBaseSha, diffSha256: rebase.diffSha256, patchId: rebase.patchId, changedPaths: rebase.changedPaths, envelope: rebase.envelope, commitMessageSha256: rebase.commitMessageSha256, approvalIteration: rebase.approvalIteration };
    const publication: any = { ...meta("i42:publication", 3), issueNumber: 42, provenanceKind: "recovery", issueIdentitySha256: issue42.identitySha256, envelope: rebase.envelope, sourceRebaseProofId: rebase.proofId, landingApprovalId, liveStateId: publicationLiveId(liveState), commitSha: rebase.headSha, candidateParentSha: rebase.newBaseSha, commitMessageSha256: rebase.commitMessageSha256, diffSha256: rebase.diffSha256, patchId: rebase.patchId, changedPaths: rebase.changedPaths, approvalIteration: rebase.approvalIteration, provenanceMatches: true, collisionEvidenceOk: true, pushed: false, reachable: true, alreadyReachable: true, retryableRace: false, fetchExitCode: 0, prePushRemoteSha: rebase.headSha, postPushRemoteSha: rebase.headSha, remoteBaseSha: rebase.headSha, originUrl: "https://github.com/smithersai/smithers.git", pushUrl: "git@github.com:smithersai/smithers.git", canonicalOrigin: true, issueIdentityMatches: true, equivalenceConsistent: true, decision: "reachable", summary: "fresh current-run no-push recovery proof" };
    publication.proofId = publicationProofId(publication); recovered.outputs.publication.push(publication); recovered.outputs.closureRefresh = recovered.outputs.closureRefresh.filter((row: any) => row.issueNumber !== 42); recovered.outputs.closeProposal = recovered.outputs.closeProposal.filter((row: any) => row.issueNumber !== 42);
    expect(publicationCausalChainValid(publication, 42, issue42.identitySha256, rebase.envelope)).toBe(true);
    const blankProvenance = { ...publication, sourceRebaseProofId: "", landingApprovalId: "" }; blankProvenance.proofId = publicationProofId(blankProvenance); expect(publicationCausalChainValid(blankProvenance, 42, issue42.identitySha256, rebase.envelope)).toBe(false);
    const recoveredFrame = await renderWorkflow(workflow, { input: retryInput, outputs: recovered.outputs, iterations, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" });
    expect(recoveredFrame.tasks.some((task) => task.nodeId === "i42:closure-refresh")).toBe(true);
  });

  test("does not stop loops or report success from boolean-only publication and closure rows", async () => {
    const outputs: any = lateOutputs(); const publication = outputs.publication.find((row: any) => row.issueNumber === 42); const refresh = outputs.closureRefresh.find((row: any) => row.issueNumber === 42); const close = outputs.closeProposal.find((row: any) => row.issueNumber === 42);
    const closure: any = { ...meta("i42:closure", 0), issueNumber: 42, sourcePublicationProofId: publication.proofId, sourceClosureRefreshId: refresh.proofId, sourceCloseApprovalId: closeApprovalId(close), sha: refresh.headSha, reachable: true, identityMatches: true, commentPosted: true, duplicateCommentAvoided: false, closed: true, idempotent: false, decision: "closed", summary: "exact closure" }; closure.proofId = closureProofId(closure);
    expect(publicationCausalChainValid(publication, 42, issue(42).identitySha256, publication.envelope)).toBe(true);
    expect(closureCausalChainValid(publication, refresh, closure, true, 42, issue(42).identitySha256, publication.envelope)).toBe(true);
    expect(publicationCausalChainValid({ ...publication, proofId: "stale" }, 42, issue(42).identitySha256, publication.envelope)).toBe(false);
    expect(closureCausalChainValid(publication, refresh, { ...closure, proofId: "stale" }, true, 42, issue(42).identitySha256, publication.envelope)).toBe(false);

    const stalePublication: any = lateOutputs(); stalePublication.publication = stalePublication.publication.map((row: any) => row.issueNumber === 42 ? { ...row, proofId: "stale", reachable: true } : row); stalePublication.closureRefresh = stalePublication.closureRefresh.filter((row: any) => row.issueNumber !== 42); stalePublication.closeProposal = stalePublication.closeProposal.filter((row: any) => row.issueNumber !== 42);
    const stalePublicationFrame = await renderWorkflow(workflow, { input, outputs: stalePublication, iterations: { "i42:correction-loop": 1, "i43:correction-loop": 1, "i42:landing-loop": 2, "i43:landing-loop": 2 }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" }); const stalePublicationTerminal = stalePublicationFrame.tasks.find((task) => task.nodeId === "i42:terminal"); expect(stalePublicationTerminal).toBeDefined(); const stalePublicationResult: any = await runTask(stalePublicationTerminal!); expect(stalePublicationResult.result).not.toBe("landed+closed");

    const staleClosure: any = lateOutputs(); staleClosure.closure = [{ ...closure, ...meta("i42:closure", 2), proofId: "stale", closed: true }];
    const staleClosureFrame = await renderWorkflow(workflow, { input, outputs: staleClosure, iterations: { "i42:correction-loop": 1, "i43:correction-loop": 1, "i42:landing-loop": 2, "i43:landing-loop": 2, "i42:closure-loop": 2 }, workflowPath: ".smithers/workflows/riskless-github-issue-sweep.tsx" }); const staleClosureTerminal = staleClosureFrame.tasks.find((task) => task.nodeId === "i42:terminal"); expect(staleClosureTerminal).toBeDefined(); const staleClosureResult: any = await runTask(staleClosureTerminal!); expect(staleClosureResult.result).not.toBe("landed+closed");
  });

  test("mechanically rejects unexpected paths, peer overlap, closed issues, query failure, and provenance drift", () => {
    expect(pathsOverlap("packages/a/src/", "packages/a/src/x.ts")).toBe(true); expect(pathsOverlap("packages/a/src/x.ts", "packages/a/src/")).toBe(true); expect(pathsOverlap("packages/a/src/", "packages/b/src/x.ts")).toBe(false);
    expect(pathsWithinEnvelope(["packages/a/src/x.ts"], ["packages/a/src/"])).toBe(true); expect(pathsWithinEnvelope(["packages/a/src/x.ts"], ["packages"])).toBe(false); expect(pathsWithinEnvelope(["packages/a/src/x.ts"], ["packages/a"])).toBe(false); expect(pathsWithinEnvelope(["packages/b/src/x.ts"], ["packages/a/src/"])).toBe(false); expect(pathsWithinEnvelope([], ["packages/a/src/"])).toBe(false);
    expect(peerPathOverlaps(42, ["packages/a/src/"], [{ issueNumber: 43, changedPaths: ["packages/a/src/x.ts"] }, { issueNumber: 44, changedPaths: ["docs/x.md"] }])).toEqual([43]);
    expect(peerPathOverlaps(42, ["packages/a/src/x.ts"], [{ issueNumber: 43, changedPaths: ["packages/a"], identicalAlreadyLanded: true }])).toEqual([]);
    expect(protectedPaths(["packages/components/package.json", ".gitattributes", "bunfig.toml", "preload.js", "scripts/release.ts", "packages/components/src/button.ts"])).toEqual([".gitattributes", "bunfig.toml", "packages/components/package.json", "preload.js", "scripts/release.ts"]);
    const exact = { issueNumber: 42, headSha: "head", diffSha256: "digest", patchId: "patch", changedPaths: ["a.ts", "b.ts"], iteration: 2 }; expect(exactLandingProvenance(exact, { ...exact })).toBe(true); expect(exactLandingProvenance(exact, { ...exact, iteration: 1 })).toBe(false); expect(exactLandingProvenance(exact, { ...exact, changedPaths: ["b.ts", "a.ts"] })).toBe(false);
    const boundary = { issueState: "open" as const, collisionQueryOk: true, collisions: [], provenanceMatches: true, canonicalRemote: true, proposalValid: true, proposalDecision: "propose" as const, stagePaths: [] }; expect(publicationBoundaryAuthorized({ ...boundary, issueState: "closed" })).toBe(false); expect(publicationBoundaryAuthorized({ ...boundary, collisionQueryOk: false })).toBe(false); expect(publicationBoundaryAuthorized({ ...boundary, proposalDecision: "defer" })).toBe(false); expect(publicationBoundaryAuthorized(boundary)).toBe(true);
  });

  test("treats a registered missing worktree as uncertain collision evidence", () => {
    const fixture = mkdtempSync(join(tmpdir(), "riskless-missing-worktree-")); const peer = join(fixture, "peer"); const git = (...args: string[]) => spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
    try {
      expect(git("init", "-q").status).toBe(0); expect(git("config", "user.name", "Test").status).toBe(0); expect(git("config", "user.email", "test@example.com").status).toBe(0); writeFileSync(join(fixture, "x.txt"), "base\n"); expect(git("add", "--", "x.txt").status).toBe(0); expect(git("commit", "-qm", "base").status).toBe(0); expect(git("worktree", "add", "--detach", peer, "HEAD").status).toBe(0); rmSync(peer, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      const orchestratorUrl = import.meta.resolve("smithers-orchestrator"); const workflowUrl = `${pathToFileURL(join(import.meta.dir, "..", "workflows", "riskless-github-issue-sweep.tsx")).href}?missing-worktree-test=${Date.now()}`;
      const script = `import { mdxPlugin } from ${JSON.stringify(orchestratorUrl)}; mdxPlugin(); const { activeCollisionPaths } = await import(${JSON.stringify(workflowUrl)}); console.log(JSON.stringify(activeCollisionPaths(["x.txt"], ${JSON.stringify(fixture)})));`;
      const child = spawnSync(process.execPath, ["-e", script], { cwd: fixture, encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } }); expect(child.status, child.stderr).toBe(0); const lines = child.stdout.trim().split(/\r?\n/); const result = JSON.parse(lines.at(-1)!); expect(result.ok).toBe(false); expect(result.collisions.some((entry: string) => entry.includes("uncertain:missing-worktree:"))).toBe(true);
    } finally { rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 30_000);

  test("proves real stable patch equivalence and blocks failed Git queries", () => {
    const fixture = mkdtempSync(join(tmpdir(), "riskless-patch-id-")); const git = (...args: string[]) => spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
    try {
      expect(git("init", "-q").status).toBe(0); expect(git("config", "user.name", "Test").status).toBe(0); expect(git("config", "user.email", "test@example.com").status).toBe(0); writeFileSync(join(fixture, "x.txt"), "base\n"); expect(git("add", "x.txt").status).toBe(0); expect(git("commit", "-qm", "base").status).toBe(0); const base = git("rev-parse", "HEAD").stdout.trim(); writeFileSync(join(fixture, "x.txt"), "same patch\n"); expect(git("commit", "-qam", "one").status).toBe(0); const one = git("rev-parse", "HEAD").stdout.trim(); expect(git("checkout", "-q", "--detach", base).status).toBe(0); writeFileSync(join(fixture, "x.txt"), "same patch\n"); expect(git("commit", "-qam", "two").status).toBe(0); const two = git("rev-parse", "HEAD").stdout.trim(); expect(one).not.toBe(two); expect(commitPatchId(fixture, one)).toBe(commitPatchId(fixture, two)); expect(() => commitPatchId(fixture, "missing")).toThrow("git show failed");
    } finally { rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 30_000);

  test("computes truthful fixpoints for exclusions, landings, missing outputs, and no-safe-work", () => {
    expect(fixpointDecision({ discoveredCount: 2, exclusions: [42], missingEvidence: [], newOrEdited: [], landedCount: 0, remainingOpen: [42], remainingIndependentlyNotRiskless: true })).toEqual({ completed: false, fixpoint: false });
    expect(fixpointDecision({ discoveredCount: 2, exclusions: [], missingEvidence: [], newOrEdited: [], landedCount: 1, remainingOpen: [43], remainingIndependentlyNotRiskless: true }).fixpoint).toBe(false);
    expect(fixpointDecision({ discoveredCount: 2, exclusions: [], missingEvidence: ["i43:terminal"], newOrEdited: [], landedCount: 0, remainingOpen: [42, 43], remainingIndependentlyNotRiskless: true }).completed).toBe(false);
    expect(fixpointDecision({ discoveredCount: 2, exclusions: [], missingEvidence: [], newOrEdited: [], landedCount: 0, remainingOpen: [42, 43], remainingIndependentlyNotRiskless: true })).toEqual({ completed: true, fixpoint: true });
    expect(dryRunMainIsCurrent("remote", "remote", "remote", "remote")).toBe(true); expect(dryRunMainIsCurrent("remote", "stale", "stale", "stale")).toBe(false);
  });

  test("runs gates against sealed candidate dependencies and denies host credentials, stores, and symlink escapes", async () => {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return;
    const fixture = mkdtempSync(join(tmpdir(), "riskless-real-sandbox-"));
    const main = join(fixture, "main"); const lane = join(fixture, "nested", "lane"); const store = join(fixture, "pnpm-store");
    const packageSource = join(fixture, "fixture-only-source");
    const operatorHome = join(fixture, "operator-home"); const outside = join(fixture, "outside");
    const hostCredential = join(operatorHome, ".gitconfig"); const storeSentinel = join(store, "operator-sentinel"); const outsideSentinel = join(outside, "operator-secret");
    const processSecret = `smithers-sibling-secret-${Date.now()}-${Math.random()}`;
    const sibling = spawn("/bin/sleep", ["60"], { env: { PATH: "/usr/bin:/bin", SMITHERS_SIBLING_SECRET: processSecret }, stdio: "ignore" });
    if (!sibling.pid) throw new Error("same-user sentinel process did not start");
    mkdirSync(main, { recursive: true }); mkdirSync(packageSource, { recursive: true }); mkdirSync(operatorHome, { recursive: true }); mkdirSync(outside, { recursive: true }); mkdirSync(store, { recursive: true });
    const git = (...args: string[]) => spawnSync("git", args, { cwd: main, encoding: "utf8" });
    const prior = { HOME: process.env.HOME, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_HOST: process.env.GH_HOST };
    let binding: ReturnType<typeof prepareIsolatedGateDependencies> | undefined;
    try {
      expect(git("init", "-q").status).toBe(0); expect(git("config", "user.name", "Test").status).toBe(0); expect(git("config", "user.email", "test@example.com").status).toBe(0);
      mkdirSync(join(main, "packages", "workspace-only"), { recursive: true });
      writeFileSync(join(main, ".gitignore"), "ignored.poison\nnode_modules\n");
      writeFileSync(join(main, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { test: "bun gate.ts" }, dependencies: { "fixture-only": "file:fixture-only-1.0.0.tgz", "workspace-only": "workspace:*" } }));
      writeFileSync(join(main, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      writeFileSync(join(main, "packages", "workspace-only", "package.json"), JSON.stringify({ name: "workspace-only", version: "1.0.0", type: "module", exports: "./index.js" }));
      writeFileSync(join(main, "packages", "workspace-only", "index.js"), "export default 11;\n");
      writeFileSync(join(packageSource, "package.json"), JSON.stringify({ name: "fixture-only", version: "1.0.0", type: "module", exports: "./index.js", files: ["index.js"] }));
      writeFileSync(join(packageSource, "index.js"), "export default 73;\n");
      writeFileSync(hostCredential, "[credential]\n\thelper = forbidden\n"); writeFileSync(storeSentinel, "operator-store-sentinel\n"); writeFileSync(outsideSentinel, "operator-outside-secret\n");
      symlinkSync(outside, join(main, "escape"), "dir");
      writeFileSync(join(main, "gate.ts"), `import value from "fixture-only"; import workspaceValue from "workspace-only"; import { readFileSync, writeFileSync } from "node:fs"; import { dlopen, FFIType, ptr } from "bun:ffi"; if (value !== 73 || workspaceValue !== 11) process.exit(40); if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_HOST) process.exit(41); try { readFileSync(${JSON.stringify(hostCredential)}); process.exit(42); } catch {} try { readFileSync(${JSON.stringify(storeSentinel)}); process.exit(43); } catch {} try { writeFileSync("escape/owned", "escaped"); process.exit(44); } catch {} try { readFileSync("escape/operator-secret"); process.exit(45); } catch {} const libc = dlopen("/usr/lib/system/libsystem_c.dylib", { sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 } }); const mib = new Int32Array([1, 49, ${JSON.stringify(sibling.pid)}]); const procBuffer = new Uint8Array(4096); const procSize = new BigUint64Array([BigInt(procBuffer.byteLength)]); const procResult = libc.symbols.sysctl(ptr(mib), mib.length, ptr(procBuffer), ptr(procSize), null, 0); const visibleBytes = procResult === 0 ? procBuffer.subarray(0, Math.min(procBuffer.byteLength, Number(procSize[0]))) : new Uint8Array(); if (Buffer.from(visibleBytes).includes(Buffer.from("SMITHERS_SIBLING_SECRET="))) process.exit(46); libc.close(); const kernel = dlopen("/usr/lib/system/libsystem_kernel.dylib", { mach_task_self: { args: [], returns: FFIType.u32 }, task_get_special_port: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } }); const system = dlopen("/usr/lib/libSystem.B.dylib", { bootstrap_look_up: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } }); const bootstrap = new Uint32Array(1); if (kernel.symbols.task_get_special_port(kernel.symbols.mach_task_self(), 4, ptr(bootstrap)) !== 0) process.exit(47); const service = new Uint32Array(1); const serviceName = Buffer.from("com.apple.SecurityServer\\0"); if (system.symbols.bootstrap_look_up(bootstrap[0], ptr(serviceName), ptr(service)) === 0) process.exit(48); system.close(); kernel.close(); writeFileSync("ignored.poison", "discard me");`);
      const pathValue = process.env.PATH ?? ""; const pnpm = resolveExecutable(pathValue, "pnpm"); expect(pnpm).toContain("pnpm"); const packed = spawnSync(pnpm, ["pack", "--pack-destination", main], { cwd: packageSource, encoding: "utf8", timeout: 30_000 }); expect(packed.status).toBe(0); expect(existsSync(join(main, "fixture-only-1.0.0.tgz"))).toBe(true);
      const install = spawnSync(pnpm, ["install", "--ignore-scripts", "--store-dir", store], { cwd: main, encoding: "utf8", timeout: 30_000 }); expect(install.status).toBe(0); expect(existsSync(join(main, "pnpm-lock.yaml"))).toBe(true);
      expect(git("add", "--", ".gitignore", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "fixture-only-1.0.0.tgz", "packages/workspace-only/package.json", "packages/workspace-only/index.js", "gate.ts", "escape").status).toBe(0); expect(git("commit", "-qm", "fixture").status).toBe(0);
      rmSync(join(main, "node_modules"), { recursive: true, force: true }); mkdirSync(join(main, "node_modules", "fixture-only"), { recursive: true }); writeFileSync(join(main, "node_modules", "fixture-only", "package.json"), JSON.stringify({ name: "fixture-only", type: "module", exports: "./index.js" })); writeFileSync(join(main, "node_modules", "fixture-only", "index.js"), "export default 999;\n");
      mkdirSync(join(fixture, "nested"), { recursive: true }); expect(git("worktree", "add", "--detach", lane, "HEAD").status).toBe(0);
      process.env.HOME = operatorHome; process.env.GH_TOKEN = "secret"; process.env.GITHUB_TOKEN = "secret"; process.env.GH_HOST = "evil.example";

      const before = completeCandidateSnapshot(lane); binding = prepareIsolatedGateDependencies(lane, { path: pathValue, storeDir: store, timeoutMs: 30_000 }); const bindingParent = binding.parent; expect(existsSync(bindingParent)).toBe(true);
      const result = runIsolatedGate(lane, ["pnpm", "test"], { binding, path: pathValue, timeoutMs: 20_000 }); const after = completeCandidateSnapshot(lane);
      expect(result.exitCode, JSON.stringify(result)).toBe(0); expect(result.signal).toBe(""); expect(result.launchError).toBe(""); expect(result.passed).toBe(true); expect(result.disposableRemoved).toBe(true); expect(result.dependencyBindingRemoved).toBe(false); expect(result.dependencyBindingId).toBe(binding.bindingId); expect(result.dependencyHead).toBe(before.head); expect(result.dependencyDigest).toBe(before.digest); expect(result.dependencyInstallArgv).toContain("--offline"); expect(result.dependencyInstallArgv).toContain("--frozen-lockfile"); expect(result.dependencyInstallArgv).toContain("--ignore-scripts"); expect(`${result.stdout}\n${result.stderr}`).not.toContain(processSecret); expect(result.unchanged).toBe(true); expect(after).toEqual(before); expect(readFileSync(storeSentinel, "utf8")).toBe("operator-store-sentinel\n"); expect(existsSync(join(outside, "owned"))).toBe(false); expect(spawnSync("git", ["status", "--porcelain", "--ignored=matching"], { cwd: lane, encoding: "utf8" }).stdout).toBe("");
      expect(disposeIsolatedGateDependencies(binding)).toBe(true); binding = undefined; expect(existsSync(bindingParent)).toBe(false);

      const originalPackage = readFileSync(join(lane, "package.json"), "utf8"); writeFileSync(join(lane, "package.json"), JSON.stringify({ ...JSON.parse(originalPackage), dependencies: { "fixture-only": "file:fixture-only-1.0.0.tgz", "workspace-only": "workspace:*", "lock-drift": "1.0.0" } })); expect(() => prepareIsolatedGateDependencies(lane, { path: pathValue, storeDir: store, timeoutMs: 20_000 })).toThrow("offline frozen dependency install failed"); writeFileSync(join(lane, "package.json"), originalPackage);
      expect(() => prepareIsolatedGateDependencies(lane, { path: pathValue, storeDir: join(fixture, "missing-store"), timeoutMs: 20_000 })).toThrow("pnpm store is absent");
      const env = sanitizedGateEnv(process.env, join(fixture, "sanitized-home")); expect(env.GH_TOKEN).toBeUndefined(); expect(env.GITHUB_TOKEN).toBeUndefined(); expect(env.GH_HOST).toBeUndefined();
    } finally {
      if (binding) disposeIsolatedGateDependencies(binding);
      if (prior.HOME === undefined) delete process.env.HOME; else process.env.HOME = prior.HOME;
      if (prior.GH_TOKEN === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prior.GH_TOKEN;
      if (prior.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prior.GITHUB_TOKEN;
      if (prior.GH_HOST === undefined) delete process.env.GH_HOST; else process.env.GH_HOST = prior.GH_HOST;
      if (sibling.exitCode === null && sibling.signalCode === null) {
        sibling.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          if (sibling.exitCode !== null || sibling.signalCode !== null) resolve();
          else sibling.once("close", () => resolve());
        });
      }
      rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 90_000);
});
