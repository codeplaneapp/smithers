// smithers-display-name: Riskless GitHub Issue Sweep
// smithers-source: one conservative admission pass, bounded correction lanes, one serialized landing queue
/** @jsxImportSource smithers-orchestrator */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ClaudeCodeAgent, CodexAgent, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { buildPublicIssueAgentPolicy, resolvePublicIssueToolchainReadPaths } from "../lib/publicIssueAgentPolicy";
import {
  CANONICAL_REPOSITORY,
  LOG_BYTES,
  MAX_LANES,
  MAX_REVIEW_BYTES,
  PROTECTED_PATH_HINTS,
  authorizeClosureRecovery,
  boundedLog,
  canonicalAdmissionEnvelope,
  commitPatchId,
  dryRunMainIsCurrent,
  exactCommitMessage,
  exactCommitTuple,
  explicitPathspec,
  focusedCommands,
  isNonBlank,
  nonBlankStrings,
  disposeIsolatedGateDependencies,
  fixpointDecision,
  pathsOverlap,
  pathsWithinEnvelope,
  peerPathOverlaps,
  prepareIsolatedGateDependencies,
  protectedPaths,
  publicationBoundaryAuthorized,
  risklessProofId,
  runIsolatedGate,
  sha256,
  stableOperationMarker,
} from "../lib/risklessGithubIssueSweep";
import ClassifyPrompt from "../prompts/riskless-github-issue-sweep-classify.mdx";
import AdjudicatePrompt from "../prompts/riskless-github-issue-sweep-adjudicate.mdx";
import SolPrompt from "../prompts/riskless-github-issue-sweep-sol-implement.mdx";
import LunaCommitPrompt from "../prompts/riskless-github-issue-sweep-luna-commit.mdx";
import FablePrompt from "../prompts/riskless-github-issue-sweep-fable-review.mdx";
import ClosePrompt from "../prompts/riskless-github-issue-sweep-luna-close.mdx";

type Json = Record<string, any>;
const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
const root = rootResult.status === 0 ? rootResult.stdout.trim() : process.cwd();
const safeHome = mkdtempSync(join(tmpdir(), "smithers-riskless-sweep-home-"));
const policyOptions = {
  safeHome,
  hostHome: homedir(),
  toolchainReadPaths: resolvePublicIssueToolchainReadPaths(process.env),
};
const readPolicy = buildPublicIssueAgentPolicy("read", process.env, policyOptions);
const writePolicy = buildPublicIssueAgentPolicy("write", process.env, policyOptions);

type Cmd = { argv: string[]; exitCode: number; stdout: string; stderr: string; ok: boolean; timedOut: boolean };
function run(
  argv: string[],
  cwd = root,
  input?: string,
  timeoutMs = 30 * 60_000,
  maxBuffer = 256 * 1024 * 1024,
  env: NodeJS.ProcessEnv = process.env,
): Cmd {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer,
    timeout: timeoutMs,
    env,
  });
  return {
    argv,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ok: result.status === 0,
    timedOut: result.signal === "SIGTERM",
  };
}
const git = (args: string[], cwd = root, input?: string) => run(["git", ...args], cwd, input);
const denied = (argv: string[], reason: string): Cmd => ({
  argv,
  exitCode: 1,
  stdout: "",
  stderr: reason,
  ok: false,
  timedOut: false,
});
const CANONICAL_GITHUB_HOST = "github.com";
const CANONICAL_GITHUB_REPO = `${CANONICAL_GITHUB_HOST}/${CANONICAL_REPOSITORY}`;
export function pinnedGithubArgv(args: string[]): string[] {
  const callerControlsHost = args.some((arg) => arg === "--hostname" || arg.startsWith("--hostname="));
  const callerControlsRepo = args.some(
    (arg) => arg === "--repo" || arg.startsWith("--repo=") || arg === "-R" || /^-R.+/.test(arg),
  );
  if (
    args[0] === "api" &&
    args.length === 2 &&
    !callerControlsHost &&
    !callerControlsRepo &&
    args[1]?.startsWith(`repos/${CANONICAL_REPOSITORY}/`)
  ) {
    return ["gh", "api", "--hostname", CANONICAL_GITHUB_HOST, args[1]];
  }
  const closeIssue = args[0] === "issue" && args[1] === "close" && args.length === 3 && /^\d+$/.test(args[2] ?? "");
  const commentIssue =
    args[0] === "issue" &&
    args[1] === "comment" &&
    args.length === 5 &&
    /^\d+$/.test(args[2] ?? "") &&
    args[3] === "--body" &&
    isNonBlank(args[4]);
  if ((closeIssue || commentIssue) && !callerControlsHost && !callerControlsRepo)
    return ["gh", ...args, "--repo", CANONICAL_GITHUB_REPO];
  throw new Error("GitHub command must target the pinned canonical host and repository");
}
export function pinnedGithubEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = {
    ...source,
    GH_HOST: CANONICAL_GITHUB_HOST,
    GH_REPO: CANONICAL_GITHUB_REPO,
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
    NO_PROXY: "*",
    no_proxy: "*",
  };
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "GH_FORCE_TTY",
    "GH_DEBUG",
    "DEBUG",
    "XDG_CONFIG_HOME",
  ])
    delete env[key];
  return env;
}
export function canonicalAncestorsSecure(
  directory: string,
  currentUid = typeof process.getuid === "function" ? process.getuid() : undefined,
): boolean {
  if (currentUid === undefined) return false;
  let ancestor = dirname(realpathSync(directory));
  for (;;) {
    const stat = lstatSync(ancestor);
    const writableByOthers = (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    const trustedOwner = stat.uid === currentUid || stat.uid === 0;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner || (writableByOthers && !sticky)) return false;
    const parent = dirname(ancestor);
    if (parent === ancestor) return true;
    ancestor = parent;
  }
}
function pinnedGithubConfigDir(source: NodeJS.ProcessEnv): string {
  const candidate =
    source.GH_CONFIG_DIR ||
    (source.XDG_CONFIG_HOME ? join(source.XDG_CONFIG_HOME, "gh") : join(source.HOME || homedir(), ".config", "gh"));
  try {
    if (!isAbsolute(candidate)) return "";
    const directory = realpathSync(candidate);
    const stat = lstatSync(directory);
    const uidMatches = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (!stat.isDirectory() || !uidMatches || (stat.mode & 0o022) !== 0 || !canonicalAncestorsSecure(directory))
      return "";
    for (const name of ["config.yml", "hosts.yml"]) {
      const file = join(directory, name);
      if (!existsSync(file)) continue;
      const fileStat = lstatSync(file);
      const fileUidMatches = typeof process.getuid !== "function" || fileStat.uid === process.getuid();
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || !fileUidMatches || (fileStat.mode & 0o022) !== 0)
        return "";
    }
    return directory;
  } catch {
    return "";
  }
}
export function pinnedGithubConfiguration(cwd = root, source: NodeJS.ProcessEnv = process.env) {
  const configDir = pinnedGithubConfigDir(source);
  if (!configDir)
    return {
      ok: false,
      configDir: "",
      env: pinnedGithubEnvironment(source),
      check: denied(["gh", "config", "get"], "secure gh config directory is unavailable"),
    };
  const env = { ...pinnedGithubEnvironment(source), GH_CONFIG_DIR: configDir };
  const check = run(
    ["gh", "config", "get", "http_unix_socket", "--host", CANONICAL_GITHUB_HOST],
    cwd,
    undefined,
    30_000,
    1024 * 1024,
    env,
  );
  return { ok: check.ok && check.stdout.length === 0 && check.stderr.length === 0, configDir, env, check };
}
export function runPinnedGithub(args: string[], cwd = root, source: NodeJS.ProcessEnv = process.env): Cmd {
  let argv: string[];
  try {
    argv = pinnedGithubArgv(args);
  } catch (error) {
    return denied(["gh", ...args], String(error));
  }
  const configuration = pinnedGithubConfiguration(cwd, source);
  if (!configuration.ok) return denied(argv, "gh http_unix_socket or config-directory boundary is unsafe");
  return run(argv, cwd, undefined, 30 * 60_000, 256 * 1024 * 1024, configuration.env);
}
const MAX_GITHUB_PAGES = 20;
function paginatedGithub(path: string): { ok: boolean; pages: Json[][]; rawJson: string; error: string } {
  const pages: Json[][] = [];
  for (let page = 1; page <= MAX_GITHUB_PAGES; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const response = runPinnedGithub(["api", `${path}${separator}per_page=100&page=${page}`]);
    if (!response.ok)
      return { ok: false, pages: [], rawJson: "", error: boundedLog(`${response.stdout}\n${response.stderr}`) };
    let rows: unknown;
    try {
      rows = JSON.parse(response.stdout);
    } catch {
      return { ok: false, pages: [], rawJson: "", error: "GitHub page was not JSON" };
    }
    if (!Array.isArray(rows)) return { ok: false, pages: [], rawJson: "", error: "GitHub page was not an array" };
    pages.push(rows as Json[]);
    if (rows.length < 100) return { ok: true, pages, rawJson: JSON.stringify(pages), error: "" };
  }
  return { ok: false, pages: [], rawJson: "", error: `GitHub pagination exceeded ${MAX_GITHUB_PAGES} pages` };
}
const value = (result: Cmd) => (result.ok ? result.stdout.trim() : "");
const fixed = <T,>(ctx: any, table: any, nodeId: string): T | undefined =>
  ctx.outputMaybe(table, { nodeId, iteration: 0 }) as T | undefined;
const current = <T,>(ctx: any, table: any, nodeId: string, iteration: number): T | undefined =>
  ctx.outputMaybe(table, { nodeId, iteration }) as T | undefined;
const nonBlank = z.string().trim().min(1);
const nonBlankArray = z.array(nonBlank).min(1);
const approvalPhase = z.enum(["candidate-commit", "landing-amend", "publication"]);

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  milestone: z.string(),
  url: z.string(),
  author: z.string(),
  state: z.enum(["open", "closed"]),
  identitySha256: z.string(),
});
const indexSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  milestone: z.string(),
  identitySha256: z.string(),
});
const commandSchema = z.object({
  argv: nonBlankArray,
  exitCode: z.number().int(),
  passed: z.boolean(),
  timedOut: z.boolean(),
  signal: z.string(),
  launchError: z.string(),
  beforeHead: z.string(),
  afterHead: z.string(),
  beforeDigest: z.string(),
  afterDigest: z.string(),
  beforeStatusSha256: z.string(),
  afterStatusSha256: z.string(),
  disposableRemoved: z.boolean(),
  unchanged: z.boolean(),
  dependencyBindingId: z.string(),
  dependencyHead: z.string(),
  dependencyDigest: z.string(),
  lockfileSha256: z.string(),
  dependencyInstallArgv: z.array(nonBlank),
  dependencyInstallExitCode: z.number().int(),
  dependencyInstallSignal: z.string(),
  dependencyInstallError: z.string(),
  dependencyInstallLog: nonBlank,
  dependencyBindingRemoved: z.boolean(),
  log: nonBlank,
});
const dispositionSchema = z.enum([
  "admit",
  "defer-risk",
  "defer-ambiguity",
  "defer-duplicate",
  "defer-excluded",
  "defer-stale",
]);
const bindingFields = { issueNumber: z.number().int().positive(), headSha: nonBlank, diffSha256: nonBlank };
const inputSchema = z.object({
  repo: z.literal(CANONICAL_REPOSITORY).nullish().default(CANONICAL_REPOSITORY),
  excludeNumbers: z.array(z.number().int().positive()).nullish().default([]),
  laneConcurrency: z.number().int().min(1).max(MAX_LANES).nullish().default(MAX_LANES),
  reviewIterations: z.number().int().min(1).max(4).nullish().default(3),
  landingRetries: z.number().int().min(1).max(5).nullish().default(3),
  dryRun: z.boolean().nullish().default(false),
  conservativeLabelHints: z.array(z.string()).nullish().default([]),
  prompt: z.string().nullish().default("Admit only independently evidenced, localized, riskless work."),
});
const schemas = {
  input: inputSchema,
  normalizeInputs: z.object({
    valid: z.boolean(),
    repo: z.literal(CANONICAL_REPOSITORY),
    excludeNumbers: z.array(z.number().int()),
    laneConcurrency: z.number().int(),
    reviewIterations: z.number().int(),
    landingRetries: z.number().int(),
    dryRun: z.boolean(),
    conservativeLabelHints: z.array(nonBlank),
    prompt: nonBlank,
    protectedPaths: z.array(nonBlank),
    summary: nonBlank,
  }),
  verifyCheckout: z.object({
    safeToProceed: z.boolean(),
    canonicalOrigin: z.boolean(),
    originUrl: z.string(),
    pushUrl: z.string(),
    lsRemoteExitCode: z.number().int(),
    remoteMainSha: z.string(),
    trackingMainSha: z.string(),
    localMainSha: z.string(),
    headSha: z.string(),
    clean: z.boolean(),
    onMain: z.boolean(),
    summary: nonBlank,
  }),
  synchronizeMain: z.object({
    safeToProceed: z.boolean(),
    canonicalOrigin: z.boolean(),
    originUrl: z.string(),
    pushUrl: z.string(),
    fetchExitCode: z.number().int(),
    localMainSha: z.string(),
    remoteMainSha: z.string(),
    classificationRoot: z.string(),
    clean: z.boolean(),
    onMain: z.boolean(),
    summary: nonBlank,
  }),
  discoverIssues: z.object({
    repo: z.literal(CANONICAL_REPOSITORY),
    baseSha: nonBlank,
    preEnumerationSha: nonBlank,
    postEnumerationSha: nonBlank,
    classificationHeadSha: nonBlank,
    classificationSnapshotReady: z.boolean(),
    enumerationBaseStable: z.boolean(),
    issues: z.array(issueSchema),
    globalIndex: z.array(indexSchema),
    completeMachineJson: z.string(),
    discoveredCount: z.number().int(),
    discoverySha256: nonBlank,
    summary: nonBlank,
  }),
  classify: z.object({
    ...bindingFields,
    decision: dispositionSchema,
    issueIdentitySha256: nonBlank,
    disposition: dispositionSchema,
    eligible: z.boolean(),
    evidence: nonBlankArray,
    acceptanceCriteria: nonBlankArray,
    likelyPaths: z.array(nonBlank),
    riskFlags: z.array(nonBlank),
    overlapIssueNumbers: z.array(z.number().int()),
    rationale: nonBlank,
  }),
  adjudicate: z.object({
    ...bindingFields,
    decision: dispositionSchema,
    issueIdentitySha256: nonBlank,
    disposition: dispositionSchema,
    approved: z.boolean(),
    evidence: nonBlankArray,
    acceptanceCriteria: nonBlankArray,
    likelyPaths: z.array(nonBlank),
    riskFlags: z.array(nonBlank),
    overlapIssueNumbers: z.array(z.number().int()),
    rationale: nonBlank,
  }),
  admissionLedger: z.object({
    valid: z.boolean(),
    coverageComplete: z.boolean(),
    syncProven: z.boolean(),
    discoveredCount: z.number().int(),
    consideredCount: z.number().int(),
    admittedIssueNumbers: z.array(z.number().int()),
    dispositions: z.array(
      z.object({
        issueNumber: z.number().int(),
        disposition: z.enum(["admitted", "deferred"]),
        reason: nonBlank,
        evidence: nonBlankArray,
        missingRoles: z.array(z.enum(["classifier", "adjudicator"])),
        likelyPaths: z.array(nonBlank),
        issueIdentitySha256: nonBlank,
      }),
    ),
    summary: nonBlank,
  }),
  laneBootstrap: z.object({
    issueNumber: z.number().int(),
    ready: z.boolean(),
    canonicalOrigin: z.boolean(),
    originUrl: z.string(),
    pushUrl: z.string(),
    fetchExitCode: z.number().int(),
    oldBaseSha: z.string(),
    baseSha: z.string(),
    headSha: z.string(),
    clean: z.boolean(),
    decision: z.enum(["ready", "defer"]),
    summary: nonBlank,
  }),
  liveRefresh: z.object({
    issueNumber: z.number().int(),
    ready: z.boolean(),
    issueOpen: z.boolean(),
    identityMatches: z.boolean(),
    issueIdentitySha256: z.string(),
    currentOriginSha: z.string(),
    activeExclusion: z.boolean(),
    collisionEvidenceOk: z.boolean(),
    globalIndexCurrent: z.boolean(),
    activeCollisionPaths: z.array(nonBlank),
    matchingFixesCommits: z.array(nonBlank),
    equivalentCommits: z.array(nonBlank),
    recoveryCommitSha: z.string(),
    recoveryDiffSha256: z.string(),
    recoveryPatchId: z.string(),
    recoveryChangedPaths: z.array(nonBlank),
    decision: z.enum(["implement", "defer"]),
    evidence: nonBlankArray,
    summary: nonBlank,
  }),
  solImplement: z.object({
    ...bindingFields,
    decision: z.enum(["implement", "correct", "defer"]),
    changedPaths: z.array(nonBlank),
    summary: nonBlank,
    acceptanceEvidence: nonBlankArray,
  }),
  protection: z.object({
    issueNumber: z.number().int(),
    headSha: z.string(),
    diffSha256: z.string(),
    passed: z.boolean(),
    violations: z.array(nonBlank),
    changedPaths: z.array(nonBlank),
    stagePaths: z.array(nonBlank),
    tooLarge: z.boolean(),
    decision: z.enum(["pass", "reject"]),
    evidence: nonBlank,
  }),
  lunaProposal: z.object({
    ...bindingFields,
    issueIdentitySha256: nonBlank,
    baseSha: nonBlank,
    patchId: nonBlank,
    approvalPhase,
    sourceProofId: nonBlank,
    approvalIteration: z.number().int().nonnegative(),
    decision: z.enum(["propose", "defer"]),
    valid: z.boolean(),
    stagePaths: z.array(nonBlank),
    changedPaths: z.array(nonBlank),
    envelope: z.array(nonBlank),
    commitMessage: nonBlank,
    rationale: nonBlank,
  }),
  commitProof: z.object({
    issueNumber: z.number().int(),
    issueIdentitySha256: nonBlank,
    baseSha: z.string(),
    parentSha: z.string(),
    preCommitHeadSha: z.string(),
    commitSha: z.string(),
    headSha: z.string(),
    diffSha256: z.string(),
    patchId: z.string(),
    envelope: z.array(nonBlank),
    approvalPhase,
    approvalIteration: z.number().int().nonnegative(),
    sourceApprovalId: z.string(),
    proofId: z.string(),
    commitMessageSha256: z.string(),
    decision: z.enum(["committed", "reject"]),
    exactlyOneCommit: z.boolean(),
    clean: z.boolean(),
    exactStagePaths: z.boolean(),
    exactChangedPaths: z.boolean(),
    protectedPathClean: z.boolean(),
    messageValid: z.boolean(),
    changedPaths: z.array(nonBlank),
    failure: z.string(),
  }),
  candidateEvidence: z.object({
    issueNumber: z.number().int(),
    baseSha: z.string(),
    headSha: z.string(),
    diffSha256: z.string(),
    patchId: z.string(),
    changedPaths: z.array(nonBlank),
    stagePaths: z.array(nonBlank),
    completePatch: z.string(),
    byteLength: z.number().int(),
    tooLarge: z.boolean(),
    clean: z.boolean(),
    statusSha256: z.string(),
    decision: z.enum(["captured", "reject-too-large-or-special"]),
    summary: nonBlank,
  }),
  fableReview: z.object({
    ...bindingFields,
    decision: z.enum(["approve", "reject"]),
    approved: z.boolean(),
    findings: z.array(nonBlank),
    acceptanceEvidence: nonBlankArray,
    summary: nonBlank,
  }),
  evidenceCheck: z.object({
    issueNumber: z.number().int(),
    headSha: z.string(),
    diffSha256: z.string(),
    passed: z.boolean(),
    protectedPathClean: z.boolean(),
    clean: z.boolean(),
    decision: z.enum(["bound", "reject"]),
    summary: nonBlank,
  }),
  gates: z.object({
    issueNumber: z.number().int(),
    headSha: z.string(),
    diffSha256: z.string(),
    passed: z.boolean(),
    commands: z.array(commandSchema),
    beforeStatusSha256: z.string(),
    afterStatusSha256: z.string(),
    unchanged: z.boolean(),
    decision: z.enum(["pass", "fail", "invalid-focused-root"]),
    summary: nonBlank,
  }),
  laneReadiness: z.object({
    issueNumber: z.number().int(),
    issueIdentitySha256: nonBlank,
    headSha: z.string(),
    diffSha256: z.string(),
    patchId: z.string(),
    changedPaths: z.array(nonBlank),
    envelope: z.array(nonBlank),
    approvalIteration: z.number().int().nonnegative(),
    sourceCommitProofId: z.string(),
    ready: z.boolean(),
    attempt: z.number().int(),
    decision: z.enum(["ready", "correct"]),
    feedback: nonBlankArray,
    summary: nonBlank,
  }),
  landingRefresh: z.object({
    issueNumber: z.number().int(),
    sourceCommitProofId: z.string(),
    approvalIteration: z.number().int().nonnegative(),
    envelope: z.array(nonBlank),
    commitMessageSha256: z.string(),
    ready: z.boolean(),
    collisionEvidenceOk: z.boolean(),
    canonicalOrigin: z.boolean(),
    originUrl: z.string(),
    pushUrl: z.string(),
    fetchExitCode: z.number().int(),
    issueOpen: z.boolean(),
    identityMatches: z.boolean(),
    issueIdentitySha256: z.string(),
    oldBaseSha: z.string(),
    newBaseSha: z.string(),
    headSha: z.string(),
    diffSha256: z.string(),
    statusSha256: z.string(),
    patchId: z.string(),
    changedPaths: z.array(nonBlank),
    matchingFixesCommits: z.array(nonBlank),
    equivalentCommits: z.array(nonBlank),
    alreadyReachable: z.boolean(),
    consistentReachability: z.boolean(),
    decision: z.enum(["rebase", "already-reachable", "defer"]),
    evidence: nonBlankArray,
    summary: nonBlank,
  }),
  rebaseProof: z.object({
    issueNumber: z.number().int(),
    issueIdentitySha256: z.string(),
    sourceCommitProofId: z.string(),
    proofId: z.string(),
    approvalIteration: z.number().int().nonnegative(),
    envelope: z.array(nonBlank),
    oldBaseSha: z.string(),
    newBaseSha: z.string(),
    sourceCommitSha: z.string(),
    headSha: z.string(),
    diffSha256: z.string(),
    patchId: z.string(),
    commitMessageSha256: z.string(),
    status: z.enum(["unchanged", "rebased", "conflict-aborted", "failed"]),
    exactlyOneCommit: z.boolean(),
    messageValid: z.boolean(),
    protectedPathClean: z.boolean(),
    clean: z.boolean(),
    abortRestored: z.boolean(),
    exactChangedPaths: z.boolean(),
    changedPaths: z.array(nonBlank),
    decision: z.enum(["review", "retry", "reject"]),
    summary: nonBlank,
  }),
  publication: z.object({
    issueNumber: z.number().int(),
    provenanceKind: z.enum(["normal", "recovery"]),
    issueIdentitySha256: nonBlank,
    envelope: nonBlankArray,
    sourceRebaseProofId: z.string(),
    landingApprovalId: z.string(),
    liveStateId: z.string(),
    proofId: z.string(),
    commitSha: z.string(),
    candidateParentSha: z.string(),
    commitMessageSha256: z.string(),
    diffSha256: z.string(),
    patchId: z.string(),
    changedPaths: z.array(nonBlank),
    approvalIteration: z.number().int().nonnegative(),
    provenanceMatches: z.boolean(),
    collisionEvidenceOk: z.boolean(),
    pushed: z.boolean(),
    reachable: z.boolean(),
    alreadyReachable: z.boolean(),
    retryableRace: z.boolean(),
    fetchExitCode: z.number().int(),
    prePushRemoteSha: z.string(),
    postPushRemoteSha: z.string(),
    remoteBaseSha: z.string(),
    originUrl: z.string(),
    pushUrl: z.string(),
    canonicalOrigin: z.boolean(),
    issueIdentityMatches: z.boolean(),
    equivalenceConsistent: z.boolean(),
    decision: z.enum(["published", "reachable", "retry", "defer"]),
    summary: nonBlank,
  }),
  closureRefresh: z.object({
    issueNumber: z.number().int(),
    sourcePublicationProofId: z.string(),
    proofId: z.string(),
    issueIdentitySha256: nonBlank,
    commitMessageSha256: z.string(),
    remoteMainSha: z.string(),
    headSha: nonBlank,
    diffSha256: nonBlank,
    patchId: nonBlank,
    changedPaths: nonBlankArray,
    approvalIteration: z.number().int().nonnegative(),
    envelope: nonBlankArray,
    closureAttempt: z.number().int().positive(),
    ready: z.boolean(),
    fetchExitCode: z.number().int(),
    canonicalOrigin: z.boolean(),
    reachable: z.boolean(),
    issueState: z.enum(["open", "closed", "missing"]),
    identityMatches: z.boolean(),
    commentsEnumerated: z.boolean(),
    markerPresent: z.boolean(),
    operationMarker: nonBlank,
    decision: z.enum(["authorize", "defer"]),
    summary: nonBlank,
  }),
  closeProposal: z.object({
    ...bindingFields,
    sourceClosureRefreshId: z.string(),
    patchId: nonBlank,
    changedPaths: nonBlankArray,
    approvalIteration: z.number().int().nonnegative(),
    envelope: nonBlankArray,
    closureAttempt: z.number().int().positive(),
    decision: z.enum(["close", "defer"]),
    comment: nonBlank,
    operationMarker: nonBlank,
    rationale: nonBlank,
  }),
  closure: z.object({
    issueNumber: z.number().int(),
    sourcePublicationProofId: z.string(),
    sourceClosureRefreshId: z.string(),
    sourceCloseApprovalId: z.string(),
    proofId: z.string(),
    sha: nonBlank,
    reachable: z.boolean(),
    identityMatches: z.boolean(),
    commentPosted: z.boolean(),
    duplicateCommentAvoided: z.boolean(),
    closed: z.boolean(),
    idempotent: z.boolean(),
    decision: z.enum(["closed", "blocked", "defer"]),
    summary: nonBlank,
  }),
  laneTerminal: z.object({
    issueNumber: z.number().int(),
    result: z.enum(["landed+closed", "deferred", "blocked"]),
    reason: nonBlank,
    evidence: nonBlankArray,
    headSha: z.string(),
    summary: nonBlank,
  }),
  finalRescan: z.object({
    enumeratedBaseSha: nonBlank,
    latestMainSha: nonBlank,
    remoteEvidenceOk: z.boolean(),
    fetchExitCode: z.number().int(),
    issueIdentityHashes: z.array(z.object({ issueNumber: z.number().int(), identitySha256: nonBlank })),
    newOrEditedIssueNumbers: z.array(z.number().int()),
    fixpoint: z.boolean(),
    complete: z.boolean(),
    summary: nonBlank,
  }),
  finalSync: z.object({
    synchronized: z.boolean(),
    deferredToOuterController: z.boolean(),
    localMainSha: z.string(),
    remoteMainSha: z.string(),
    clean: z.boolean(),
    onMain: z.boolean(),
    fetchExitCode: z.number().int(),
    summary: nonBlank,
  }),
  finalReport: z.object({
    status: z.enum(["completed", "dry-run", "partial"]),
    successful: z.boolean(),
    discoveredCount: z.number().int(),
    admitted: z.array(z.number().int()),
    terminal: z.array(z.object({ issueNumber: z.number().int(), result: nonBlank, reason: nonBlank })),
    fixpoint: z.boolean(),
    summary: nonBlank,
  }),
};

const { Workflow, Task, Sequence, Parallel, Branch, Loop, MergeQueue, UI, smithers, outputs } = createSmithers(schemas);

export function pinnedCodexConfigDirectory(
  candidate = process.env.CODEX_HOME || join(homedir(), ".codex"),
  workspaceRoot = root,
): string {
  try {
    // POSIX owner/mode bits are the boundary proved below. Windows requires an
    // ACL-aware implementation; until then it must use the deterministic
    // unavailable-agent path rather than accepting a weaker approximation.
    if (process.platform === "win32") return "";
    if (!isAbsolute(candidate)) return "";
    const directory = realpathSync(candidate);
    const stat = lstatSync(directory);
    const uidMatches = typeof process.getuid !== "function" || stat.uid === process.getuid();
    const fromWorkspace = relative(realpathSync(workspaceRoot), directory);
    const insideWorkspace =
      fromWorkspace === "" ||
      (!isAbsolute(fromWorkspace) && fromWorkspace !== ".." && !fromWorkspace.startsWith(`..${sep}`));
    const directoryModeSafe = (stat.mode & 0o022) === 0;
    if (!stat.isDirectory() || !uidMatches || insideWorkspace || !directoryModeSafe) return "";
    // Every canonical ancestor must either be non-writable by other users or
    // sticky (for example /tmp). Otherwise another uid could rename the
    // already-validated private directory between this check and Codex spawn.
    if (!canonicalAncestorsSecure(directory)) return "";
    const authFile = join(directory, "auth.json");
    const authStat = lstatSync(authFile);
    const authUidMatches = typeof process.getuid !== "function" || authStat.uid === process.getuid();
    const authModeSafe = (authStat.mode & 0o077) === 0;
    if (!authStat.isFile() || authStat.isSymbolicLink() || !authUidMatches || !authModeSafe) return "";
    return directory;
  } catch {
    return "";
  }
}

function codex(model: "gpt-5.6-sol" | "gpt-5.6-luna", role: "read" | "write", cwd: string) {
  const policy = role === "read" ? readPolicy : writePolicy;
  // Rendering must remain CI-safe on machines without an agent login, but an
  // absent/unsafe directory may never fall back to any ambient CLI account.
  // The deterministic adapter fails the task before starting a subprocess.
  const configDir = pinnedCodexConfigDirectory();
  if (!configDir)
    return {
      id: `riskless-${model}-auth-unavailable`,
      model: "deterministic-auth-unavailable",
      tools: {},
      supportsNativeStructuredOutput: true,
      async generate() {
        throw new Error("secure Codex auth directory unavailable");
      },
    };
  return new CodexAgent({ ...policy.codex, model, cwd, configDir, skipGitRepoCheck: true });
}
function fable(cwd: string) {
  return new ClaudeCodeAgent({
    ...readPolicy.claude,
    model: "claude-fable-5",
    cwd,
    configDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  });
}
function failClosedClosureAgent(
  issueNumber: number,
  headSha: string,
  operationMarker: string,
  patchId: string,
  changedPaths: string[],
  approvalIteration: number,
  envelope: string[],
  closureAttempt: number,
  sourceClosureRefreshId: string,
) {
  return {
    id: `riskless-close-fail-closed-${issueNumber}`,
    model: "deterministic-fail-closed",
    tools: {},
    supportsNativeStructuredOutput: true,
    async generate() {
      return {
        output: {
          issueNumber,
          headSha,
          diffSha256: operationMarker,
          sourceClosureRefreshId,
          patchId,
          changedPaths,
          approvalIteration,
          envelope,
          closureAttempt,
          decision: "defer" as const,
          comment: "deferred",
          operationMarker,
          rationale: "Luna produced no schema-valid closure authorization; deterministic fallback forbids mutation.",
        },
      };
    },
  };
}
export function canonicalRemoteConfiguration(cwd = root) {
  const fetch = git(["remote", "get-url", "--all", "origin"], cwd);
  const push = git(["remote", "get-url", "--push", "--all", "origin"], cwd);
  const unsafeLocal = git(
    [
      "config",
      "--local",
      "--name-only",
      "--get-regexp",
      "^(url\\..*\\.(insteadof|pushinsteadof)|http(\\..*)?|credential(\\..*)?|core\\.sshcommand|ssh\\..*|remote\\.origin\\.(proxy|proxyauthmethod))$",
    ],
    cwd,
  );
  const fetchUrls = fetch.ok
    ? fetch.stdout
        .split(/\r?\n/)
        .map((url) => url.trim())
        .filter(Boolean)
    : [];
  const pushUrls = push.ok
    ? push.stdout
        .split(/\r?\n/)
        .map((url) => url.trim())
        .filter(Boolean)
    : [];
  const localTransportSafe = unsafeLocal.exitCode === 1 && unsafeLocal.stdout.trim() === "";
  const ok =
    fetch.ok &&
    push.ok &&
    localTransportSafe &&
    fetchUrls.length === 1 &&
    pushUrls.length === 1 &&
    fetchUrls[0] === "https://github.com/smithersai/smithers.git" &&
    pushUrls[0] === "https://github.com/smithersai/smithers.git";
  return {
    ok,
    localTransportSafe,
    fetchUrls,
    pushUrls,
    fetchUrl: fetchUrls.length === 1 ? fetchUrls[0]! : "",
    pushUrl: pushUrls.length === 1 ? pushUrls[0]! : "",
  };
}
function origin(cwd = root) {
  return canonicalRemoteConfiguration(cwd).fetchUrls.join("\n");
}
function pushOrigin(cwd = root) {
  return canonicalRemoteConfiguration(cwd).pushUrls.join("\n");
}
function canonicalOrigin(cwd = root) {
  return canonicalRemoteConfiguration(cwd).ok;
}
function gitNetworkEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = pinnedGithubEnvironment({ ...source, GIT_TERMINAL_PROMPT: "0" });
  for (const key of Object.keys(env))
    if (
      /^(?:GIT_CONFIG(?:_|$)|GIT_SSH(?:_|$)|GIT_PROXY_COMMAND$|GIT_ASKPASS$|SSH_ASKPASS$|GIT_SSL_NO_VERIFY$|GIT_SSL_CAINFO$)/.test(
        key,
      )
    )
      delete env[key];
  return env;
}
function networkGit(args: string[], cwd = root): Cmd {
  return run(
    [
      "git",
      "-c",
      "http.sslVerify=true",
      "-c",
      "http.followRedirects=false",
      "-c",
      "http.proxy=",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      ...args,
    ],
    cwd,
    undefined,
    30 * 60_000,
    256 * 1024 * 1024,
    gitNetworkEnvironment(),
  );
}
export function fetchCanonicalMain(cwd = root): Cmd {
  const remote = canonicalRemoteConfiguration(cwd);
  return remote.ok
    ? networkGit(["fetch", "--no-tags", remote.fetchUrl, "+refs/heads/main:refs/remotes/origin/main"], cwd)
    : denied(
        ["git", "fetch"],
        "origin must have exactly one canonical HTTPS fetch URL and push URL with safe local transport config",
      );
}
export function pushCanonicalMain(cwd: string, sha: string): Cmd {
  const remote = canonicalRemoteConfiguration(cwd);
  return remote.ok
    ? networkGit(["push", "--porcelain", remote.pushUrl, `${sha}:refs/heads/main`], cwd)
    : denied(
        ["git", "push"],
        "origin must have exactly one canonical HTTPS fetch URL and push URL with safe local transport config",
      );
}
function remoteSha(cwd = root) {
  return value(git(["rev-parse", "refs/remotes/origin/main"], cwd));
}
function status(cwd: string) {
  const result = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  return result.ok ? result.stdout : `STATUS-ERROR:${result.exitCode}:${result.stderr}`;
}
function residueStatus(cwd: string) {
  const result = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], cwd);
  return result.ok ? result.stdout : `STATUS-ERROR:${result.exitCode}:${result.stderr}`;
}
function issueIdentity(raw: Json) {
  return sha256(
    JSON.stringify({
      number: raw.number,
      title: raw.title ?? "",
      body: raw.body ?? "",
      labels: (raw.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)).sort(),
      assignees: (raw.assignees ?? []).map((a: any) => (typeof a === "string" ? a : a.login)).sort(),
      milestone: typeof raw.milestone === "string" ? raw.milestone : (raw.milestone?.title ?? ""),
    }),
  );
}
function normalizeIssue(raw: Json) {
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ""),
    body: String(raw.body ?? ""),
    labels: (raw.labels ?? []).map((l: any) => String(typeof l === "string" ? l : l.name)).sort(),
    assignees: (raw.assignees ?? []).map((a: any) => String(typeof a === "string" ? a : a.login)).sort(),
    milestone: String(typeof raw.milestone === "string" ? raw.milestone : (raw.milestone?.title ?? "")),
    url: String(raw.html_url ?? raw.url ?? ""),
    author: String(raw.user?.login ?? raw.author ?? ""),
    state: String(raw.state).toLowerCase() === "closed" ? ("closed" as const) : ("open" as const),
    identitySha256: issueIdentity(raw),
  };
}
function discoverOpenIssues() {
  const response = paginatedGithub(`repos/${CANONICAL_REPOSITORY}/issues?state=open`);
  if (!response.ok) throw new Error(response.error);
  const pages = response.pages;
  const raw = pages.flat().filter((row: Json) => !row.pull_request && String(row.state).toLowerCase() === "open");
  return { rawJson: response.rawJson, issues: raw.map(normalizeIssue).sort((a, b) => a.number - b.number) };
}
function fetchIssue(number: number) {
  const result = runPinnedGithub(["api", `repos/${CANONICAL_REPOSITORY}/issues/${number}`]);
  if (!result.ok) return null;
  try {
    const raw = JSON.parse(result.stdout);
    return raw.pull_request ? null : normalizeIssue(raw);
  } catch {
    return null;
  }
}
export type CollisionEvidence = { ok: boolean; collisions: string[] };
export function activeCollisionPaths(likelyPaths: string[], laneCwd: string): CollisionEvidence {
  const collisions: string[] = [];
  let ok = true;
  const pulls = paginatedGithub(`repos/${CANONICAL_REPOSITORY}/pulls?state=open`);
  try {
    const pages = pulls.ok ? pulls.pages : [];
    if (!pulls.ok || !Array.isArray(pages) || !pages.every(Array.isArray)) {
      ok = false;
      collisions.push("uncertain:open-pr-enumeration");
    } else
      for (const pull of pages.flat()) {
        const files = paginatedGithub(`repos/${CANONICAL_REPOSITORY}/pulls/${Number(pull.number)}/files`);
        try {
          const filePages = files.ok ? files.pages : [];
          if (!files.ok || !Array.isArray(filePages) || !filePages.every(Array.isArray)) {
            ok = false;
            collisions.push(`uncertain:pr-${Number(pull.number)}-files`);
          } else
            for (const file of filePages.flat())
              if (likelyPaths.some((likely) => pathsOverlap(likely, String(file.filename ?? ""))))
                collisions.push(`pr-${Number(pull.number)}:${String(file.filename)}`);
        } catch {
          ok = false;
          collisions.push(`uncertain:pr-${Number(pull.number)}-files`);
        }
      }
  } catch {
    ok = false;
    collisions.push("uncertain:open-pr-enumeration");
  }
  const worktrees = git(["worktree", "list", "--porcelain"], root);
  if (!worktrees.ok) {
    ok = false;
    collisions.push("uncertain:worktree-enumeration");
  } else
    for (const block of worktrees.stdout.split(/\n\n+/)) {
      const path = block.match(/^worktree (.+)$/m)?.[1];
      if (!path || resolve(path) === resolve(laneCwd)) continue;
      if (!existsSync(path)) {
        ok = false;
        collisions.push(`uncertain:missing-worktree:${path}`);
        continue;
      }
      const peerStatus = stagePaths(path);
      if (!peerStatus.ok) {
        ok = false;
        collisions.push(`uncertain:worktree-status:${path}`);
        continue;
      }
      for (const changed of peerStatus.paths)
        if (likelyPaths.some((likely) => pathsOverlap(likely, changed))) collisions.push(`worktree:${path}:${changed}`);
      const peerHead = git(["rev-parse", "HEAD"], path);
      const peerCommits = git(["rev-list", "--name-only", "--format=", "refs/remotes/origin/main..HEAD", "--"], path);
      if (!peerHead.ok || !peerCommits.ok) {
        ok = false;
        collisions.push(`uncertain:peer-commit-query:${path}`);
        continue;
      }
      for (const changed of explicitPathspec(peerCommits.stdout.split(/\r?\n/).filter(Boolean))) {
        if (likelyPaths.some((likely) => pathsOverlap(likely, changed)))
          collisions.push(`peer-commit:${path}:${changed}`);
      }
    }
  return { ok, collisions: explicitPathspec(collisions) };
}
function stagePaths(cwd: string): { ok: boolean; paths: string[] } {
  const result = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  if (!result.ok) return { ok: false, paths: [] };
  const raw = result.stdout;
  const entries = raw.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    const path = item.slice(3);
    paths.push(path);
    if (/[RC]/.test(item.slice(0, 2)) && entries[i + 1]) paths.push(entries[++i]);
  }
  return { ok: true, paths: explicitPathspec(paths) };
}
function changedPaths(base: string, cwd: string) {
  const result = git(["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", `${base}..HEAD`, "--"], cwd);
  if (!result.ok) throw new Error(`changed-path query failed: ${result.exitCode}`);
  return explicitPathspec(result.stdout.split("\0").filter(Boolean));
}
function evidence(issueNumber: number, base: string, cwd: string) {
  const trackedResult = run(
    ["git", "diff", "--binary", "--full-index", "--no-ext-diff", base, "--"],
    cwd,
    undefined,
    5 * 60_000,
    MAX_REVIEW_BYTES + 1,
  );
  const tracked = trackedResult.ok ? trackedResult.stdout : "";
  const untrackedResult = git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  const untracked = untrackedResult.ok ? explicitPathspec(untrackedResult.stdout.split("\0").filter(Boolean)) : [];
  const untrackedChunks: string[] = [];
  let rejectedSpecial = !trackedResult.ok || !untrackedResult.ok;
  let bytesSoFar = Buffer.byteLength(tracked);
  for (const path of untracked) {
    const absolute = resolve(cwd, path);
    let fileSize = MAX_REVIEW_BYTES + 1;
    try {
      const stat = lstatSync(absolute);
      const real = realpathSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || real !== absolute || !absolute.startsWith(`${resolve(cwd)}/`)) {
        rejectedSpecial = true;
        continue;
      }
      fileSize = stat.size;
    } catch {
      rejectedSpecial = true;
      continue;
    }
    if (fileSize > MAX_REVIEW_BYTES || bytesSoFar + fileSize > MAX_REVIEW_BYTES) {
      rejectedSpecial = true;
      continue;
    }
    const diff = run(
      ["git", "diff", "--no-index", "--binary", "--full-index", "--no-ext-diff", "--", "/dev/null", path],
      cwd,
      undefined,
      5 * 60_000,
      MAX_REVIEW_BYTES - bytesSoFar + 1,
    );
    if (diff.exitCode !== 1 || !diff.stdout) {
      rejectedSpecial = true;
      continue;
    }
    bytesSoFar += Buffer.byteLength(diff.stdout);
    if (bytesSoFar > MAX_REVIEW_BYTES) {
      rejectedSpecial = true;
      continue;
    }
    untrackedChunks.push(diff.stdout);
  }
  const completePatch = `${tracked}${untrackedChunks.join("")}`;
  const stableId = run(["git", "patch-id", "--stable"], cwd, completePatch, 5 * 60_000, MAX_REVIEW_BYTES + 1024);
  const fullPatchId = stableId.ok ? (stableId.stdout.trim().split(/\s+/)[0] ?? "") : "";
  const stagedResult = stagePaths(cwd);
  const staged = stagedResult.paths;
  const names = git(["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", base, "--"], cwd);
  const finalPaths = explicitPathspec([...(names.ok ? names.stdout.split("\0").filter(Boolean) : []), ...untracked]);
  for (const path of finalPaths) {
    try {
      const stat = lstatSync(resolve(cwd, path));
      if (stat.isSymbolicLink() || !stat.isFile()) rejectedSpecial = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") rejectedSpecial = true;
      // A genuinely deleted regular file is valid evidence.
    }
  }
  const statusText = status(cwd);
  rejectedSpecial ||=
    !names.ok || !stagedResult.ok || statusText.startsWith("STATUS-ERROR:") || !value(git(["rev-parse", "HEAD"], cwd));
  const byteLength = Buffer.byteLength(completePatch);
  const tooLarge = rejectedSpecial || byteLength > MAX_REVIEW_BYTES || (byteLength > 0 && !fullPatchId);
  return {
    issueNumber,
    baseSha: base,
    headSha: value(git(["rev-parse", "HEAD"], cwd)),
    diffSha256: sha256(completePatch),
    patchId: fullPatchId,
    changedPaths: finalPaths,
    stagePaths: staged,
    completePatch,
    byteLength,
    tooLarge,
    clean: statusText === "",
    statusSha256: sha256(statusText),
    decision: tooLarge ? "reject-too-large-or-special" : "captured",
    summary: tooLarge
      ? "Candidate exceeded the review ceiling, contained a symlink/non-regular file, escaped the lane, or could not be read safely."
      : "Complete tracked, staged, deleted, binary, and untracked candidate evidence captured without truncation.",
  };
}
export function candidateEvidenceProof(
  issue: Json,
  candidate: Json,
  envelope: string[],
  phase: "candidate-commit" | "landing-amend" | "publication",
  iteration: number,
) {
  return risklessProofId("candidate-evidence", [
    CANONICAL_REPOSITORY,
    issue.number,
    issue.identitySha256,
    candidate.baseSha,
    candidate.headSha,
    candidate.diffSha256,
    candidate.patchId,
    candidate.changedPaths,
    candidate.stagePaths,
    envelope,
    phase,
    iteration,
  ]);
}
export function lunaApprovalProof(proposal: Json) {
  return risklessProofId("luna-approval", [
    proposal.sourceProofId,
    proposal.issueNumber,
    proposal.issueIdentitySha256,
    proposal.baseSha,
    proposal.headSha,
    proposal.diffSha256,
    proposal.patchId,
    proposal.changedPaths,
    proposal.stagePaths,
    proposal.envelope,
    proposal.approvalPhase,
    proposal.approvalIteration,
    sha256(String(proposal.commitMessage ?? "").trimEnd()),
    proposal.decision,
    proposal.valid,
  ]);
}
export function commitProofIdentifier(proof: Json) {
  return risklessProofId("commit-proof", [
    proof.sourceApprovalId,
    proof.issueNumber,
    proof.issueIdentitySha256,
    proof.baseSha,
    proof.parentSha,
    proof.preCommitHeadSha,
    proof.commitSha,
    proof.diffSha256,
    proof.patchId,
    proof.changedPaths,
    proof.envelope,
    proof.commitMessageSha256,
    proof.approvalPhase,
    proof.approvalIteration,
  ]);
}
export function rebaseProofIdentifier(proof: Json) {
  return risklessProofId("rebase-proof", [
    proof.sourceCommitProofId,
    proof.issueNumber,
    proof.issueIdentitySha256,
    proof.oldBaseSha,
    proof.newBaseSha,
    proof.sourceCommitSha,
    proof.headSha,
    proof.diffSha256,
    proof.patchId,
    proof.changedPaths,
    proof.envelope,
    proof.commitMessageSha256,
    proof.approvalIteration,
    proof.status,
    proof.exactlyOneCommit,
    proof.messageValid,
    proof.protectedPathClean,
    proof.clean,
    proof.exactChangedPaths,
    proof.decision,
  ]);
}
export function publicationLiveStateId(input: Json) {
  return risklessProofId("publication-live-state", [
    input.provenanceKind,
    input.sourceRebaseProofId,
    input.landingApprovalId,
    input.issueNumber,
    input.issueIdentitySha256,
    input.remoteSha,
    input.lsRemoteSha,
    input.issueState,
    input.liveIssueIdentitySha256,
    input.canonicalOrigin,
    input.collisionOk,
    input.collisions,
    input.fixes,
    input.equivalents,
    input.queriesOk,
    input.clean,
    input.commitSha,
    input.parentSha,
    input.diffSha256,
    input.patchId,
    input.changedPaths,
    input.envelope,
    input.commitMessageSha256,
    input.approvalIteration,
  ]);
}
export function publicationProofIdentifier(proof: Json) {
  return risklessProofId("publication-proof", [
    proof.liveStateId,
    proof.sourceRebaseProofId,
    proof.landingApprovalId,
    proof.provenanceKind,
    proof.issueNumber,
    proof.issueIdentitySha256,
    proof.commitSha,
    proof.candidateParentSha,
    proof.diffSha256,
    proof.patchId,
    proof.changedPaths,
    proof.envelope,
    proof.commitMessageSha256,
    proof.approvalIteration,
    proof.prePushRemoteSha,
    proof.postPushRemoteSha,
    proof.provenanceMatches,
    proof.collisionEvidenceOk,
    proof.pushed,
    proof.reachable,
    proof.alreadyReachable,
    proof.retryableRace,
    proof.canonicalOrigin,
    proof.issueIdentityMatches,
    proof.equivalenceConsistent,
    proof.decision,
  ]);
}
export function closureRefreshProofIdentifier(proof: Json) {
  return risklessProofId("closure-refresh", [
    proof.sourcePublicationProofId,
    proof.issueNumber,
    proof.issueIdentitySha256,
    proof.headSha,
    proof.diffSha256,
    proof.patchId,
    proof.changedPaths,
    proof.envelope,
    proof.commitMessageSha256,
    proof.approvalIteration,
    proof.remoteMainSha,
    proof.closureAttempt,
    proof.ready,
    proof.canonicalOrigin,
    proof.reachable,
    proof.issueState,
    proof.identityMatches,
    proof.commentsEnumerated,
    proof.markerPresent,
    proof.operationMarker,
    proof.decision,
  ]);
}
export function closeApprovalProof(proposal: Json) {
  return risklessProofId("close-approval", [
    proposal.sourceClosureRefreshId,
    proposal.issueNumber,
    proposal.headSha,
    proposal.diffSha256,
    proposal.patchId,
    proposal.changedPaths,
    proposal.envelope,
    proposal.approvalIteration,
    proposal.closureAttempt,
    proposal.operationMarker,
    proposal.decision,
    sha256(String(proposal.comment ?? "").trim()),
  ]);
}
export function closureProofIdentifier(proof: Json) {
  return risklessProofId("closure-proof", [
    proof.sourcePublicationProofId,
    proof.sourceClosureRefreshId,
    proof.sourceCloseApprovalId,
    proof.issueNumber,
    proof.sha,
    proof.reachable,
    proof.identityMatches,
    proof.commentPosted,
    proof.duplicateCommentAvoided,
    proof.closed,
    proof.idempotent,
    proof.decision,
  ]);
}
export function publicationCausalChainValid(
  proof: Json | undefined,
  issueNumber: number,
  issueIdentitySha256: string,
  envelope: string[],
) {
  return (
    proof?.issueNumber === issueNumber &&
    proof?.issueIdentitySha256 === issueIdentitySha256 &&
    orderedEqual(proof?.envelope, envelope) &&
    isNonBlank(proof?.sourceRebaseProofId) &&
    isNonBlank(proof?.landingApprovalId) &&
    isNonBlank(proof?.proofId) &&
    proof.proofId === publicationProofIdentifier(proof) &&
    proof.reachable === true &&
    proof.provenanceMatches === true &&
    proof.collisionEvidenceOk === true &&
    proof.canonicalOrigin === true &&
    proof.issueIdentityMatches === true &&
    proof.equivalenceConsistent === true &&
    (proof.decision === "published" || proof.decision === "reachable")
  );
}
export function closureCausalChainValid(
  publication: Json | undefined,
  refresh: Json | undefined,
  closure: Json | undefined,
  closeAuthorized: boolean,
  issueNumber: number,
  issueIdentitySha256: string,
  envelope: string[],
) {
  const publicationValid = publicationCausalChainValid(publication, issueNumber, issueIdentitySha256, envelope);
  const refreshValid =
    publicationValid &&
    refresh?.issueNumber === issueNumber &&
    refresh?.issueIdentitySha256 === issueIdentitySha256 &&
    refresh?.sourcePublicationProofId === publication?.proofId &&
    refresh?.proofId === closureRefreshProofIdentifier(refresh) &&
    refresh?.headSha === publication?.commitSha &&
    orderedEqual(refresh?.envelope, envelope) &&
    refresh?.ready === true &&
    refresh?.canonicalOrigin === true &&
    refresh?.reachable === true &&
    refresh?.identityMatches === true &&
    refresh?.decision === "authorize";
  const approvalBound =
    refresh?.issueState === "closed"
      ? closure?.sourceCloseApprovalId === ""
      : refresh?.issueState === "open" && closeAuthorized;
  return (
    refreshValid &&
    closure?.issueNumber === issueNumber &&
    closure?.sourcePublicationProofId === publication?.proofId &&
    closure?.sourceClosureRefreshId === refresh?.proofId &&
    closure?.proofId === closureProofIdentifier(closure) &&
    closure?.sha === refresh?.headSha &&
    closure?.reachable === true &&
    closure?.identityMatches === true &&
    closure?.closed === true &&
    closure?.decision === "closed" &&
    approvalBound
  );
}
function equivalentCommits(patchId: string, base: string, changedPaths: string[], cwd: string) {
  if (!patchId || changedPaths.length === 0) return [];
  const listed = git(["rev-list", base, "--", ...explicitPathspec(changedPaths)], cwd);
  if (!listed.ok) return [`QUERY-ERROR:rev-list:${listed.exitCode}`];
  const commits = listed.stdout.split(/\r?\n/).filter(Boolean);
  const matches: string[] = [];
  for (const sha of commits)
    try {
      if (commitPatchId(cwd, sha) === patchId) matches.push(sha);
    } catch {
      return [`QUERY-ERROR:patch-id:${sha}`];
    }
  return matches;
}
function equivalentIssueCommits(issueNumber: number, base: string, cwd: string) {
  const references = git(
    [
      "log",
      base,
      "--format=%H",
      "--extended-regexp",
      "--regexp-ignore-case",
      "--grep",
      `(#${issueNumber}($|[^0-9])|issues/${issueNumber}($|[^0-9]))`,
    ],
    cwd,
  );
  return references.ok
    ? explicitPathspec(references.stdout.split(/\r?\n/).filter(Boolean))
    : [`QUERY-ERROR:issue-reference-log:${references.exitCode}`];
}
function matchingFixes(issueNumber: number, base: string, cwd: string) {
  const result = git(
    [
      "log",
      base,
      "--format=%H",
      "--extended-regexp",
      "--regexp-ignore-case",
      "--grep",
      `(^|[[:space:]])(fix(e[sd])?|close[sd]?|resolve[sd]?) +#${issueNumber}([^0-9]|$)`,
    ],
    cwd,
  );
  return result.ok
    ? explicitPathspec(result.stdout.split(/\r?\n/).filter(Boolean))
    : [`QUERY-ERROR:fixes-log:${result.exitCode}`];
}
function ensureDetachedWorktree(path: string, sha: string) {
  if (existsSync(path)) {
    const existing = value(git(["rev-parse", "HEAD"], path));
    return {
      ok: existing === sha && status(path) === "",
      stderr: existing === sha ? "" : `existing classification snapshot ${existing} != ${sha}`,
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  return git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", path, sha], root);
}
export function cleanLaneResidue(cwd: string, targetHead: string): boolean {
  const rebaseMerge = value(git(["rev-parse", "--git-path", "rebase-merge"], cwd));
  const rebaseApply = value(git(["rev-parse", "--git-path", "rebase-apply"], cwd));
  const rebasing =
    (rebaseMerge && existsSync(resolve(cwd, rebaseMerge))) || (rebaseApply && existsSync(resolve(cwd, rebaseApply)));
  const abort = rebasing ? git(["rebase", "--abort"], cwd) : { ok: true };
  const reset = git(["reset", "--hard", targetHead], cwd);
  const clean = git(["clean", "-ffdqx"], cwd);
  return (
    abort.ok &&
    reset.ok &&
    clean.ok &&
    value(git(["rev-parse", "HEAD"], cwd)) === targetHead &&
    residueStatus(cwd) === "" &&
    git(["diff", "--cached", "--quiet", "--"], cwd).ok
  );
}
function runGates(issueNumber: number, base: string, head: string, cwd: string, paths: string[]) {
  const captured = evidence(issueNumber, base, cwd);
  let commands: string[][] = [];
  try {
    commands = focusedCommands(cwd, paths);
  } catch (error) {
    return {
      issueNumber,
      headSha: head,
      diffSha256: captured.diffSha256,
      passed: false,
      commands: [],
      beforeStatusSha256: captured.statusSha256,
      afterStatusSha256: captured.statusSha256,
      unchanged: false,
      decision: "invalid-focused-root",
      summary: String(error),
    };
  }
  let binding: ReturnType<typeof prepareIsolatedGateDependencies>;
  try {
    binding = prepareIsolatedGateDependencies(cwd);
  } catch (error) {
    return {
      issueNumber,
      headSha: head,
      diffSha256: captured.diffSha256,
      passed: false,
      commands: [],
      beforeStatusSha256: captured.statusSha256,
      afterStatusSha256: captured.statusSha256,
      unchanged: false,
      decision: "fail",
      summary: `Candidate-bound offline frozen dependency materialization failed closed: ${String(error)}`,
    };
  }
  const results: Json[] = [];
  let dependencyBindingRemoved = false;
  try {
    for (const argv of commands) {
      try {
        const result = runIsolatedGate(cwd, argv, { binding });
        const rawLog = `${result.stdout}\n${result.stderr}\n${result.launchError}`;
        const installLog = result.dependencyInstallLog;
        results.push({
          argv,
          exitCode: result.exitCode,
          passed: result.passed,
          timedOut: result.timedOut,
          signal: result.signal,
          launchError: result.launchError,
          beforeHead: result.before.head,
          afterHead: result.after.head,
          beforeDigest: result.before.digest,
          afterDigest: result.after.digest,
          beforeStatusSha256: sha256(result.before.status),
          afterStatusSha256: sha256(result.after.status),
          disposableRemoved: result.disposableRemoved,
          unchanged: result.unchanged,
          dependencyBindingId: result.dependencyBindingId,
          dependencyHead: result.dependencyHead,
          dependencyDigest: result.dependencyDigest,
          lockfileSha256: result.lockfileSha256,
          dependencyInstallArgv: result.dependencyInstallArgv,
          dependencyInstallExitCode: result.dependencyInstallExitCode,
          dependencyInstallSignal: result.dependencyInstallSignal,
          dependencyInstallError: result.dependencyInstallError,
          dependencyInstallLog: isNonBlank(installLog)
            ? installLog
            : "offline frozen dependency materialization completed without output",
          dependencyBindingRemoved: false,
          log: boundedLog(
            isNonBlank(rawLog) ? rawLog : "command completed without stdout, stderr, or a launch error",
            LOG_BYTES,
          ),
        });
      } catch (error) {
        results.push({
          argv,
          exitCode: 126,
          passed: false,
          timedOut: false,
          signal: "",
          launchError: String(error),
          beforeHead: "",
          afterHead: "",
          beforeDigest: "",
          afterDigest: "",
          beforeStatusSha256: "",
          afterStatusSha256: "",
          disposableRemoved: false,
          unchanged: false,
          dependencyBindingId: binding.bindingId,
          dependencyHead: binding.candidate.head,
          dependencyDigest: binding.candidate.digest,
          lockfileSha256: binding.lockfileSha256,
          dependencyInstallArgv: binding.install.argv,
          dependencyInstallExitCode: binding.install.exitCode,
          dependencyInstallSignal: binding.install.signal,
          dependencyInstallError: binding.install.launchError,
          dependencyInstallLog: isNonBlank(
            `${binding.install.stdout}\n${binding.install.stderr}\n${binding.install.launchError}`,
          )
            ? boundedLog(
                `${binding.install.stdout}\n${binding.install.stderr}\n${binding.install.launchError}`,
                LOG_BYTES,
              )
            : "offline frozen dependency materialization completed without output",
          dependencyBindingRemoved: false,
          log: boundedLog(String(error), LOG_BYTES),
        });
      }
    }
  } finally {
    try {
      dependencyBindingRemoved = disposeIsolatedGateDependencies(binding);
    } catch {
      dependencyBindingRemoved = false;
    }
    for (const result of results) {
      result.dependencyBindingRemoved = dependencyBindingRemoved;
      result.passed = result.passed === true && dependencyBindingRemoved;
    }
  }
  const after = evidence(issueNumber, base, cwd);
  const unchanged =
    captured.headSha === head &&
    after.headSha === head &&
    captured.diffSha256 === after.diffSha256 &&
    captured.statusSha256 === after.statusSha256 &&
    dependencyBindingRemoved &&
    results.every(
      (x) =>
        x.unchanged &&
        x.disposableRemoved &&
        x.dependencyBindingRemoved &&
        x.dependencyBindingId === binding.bindingId &&
        x.dependencyHead === captured.headSha &&
        x.dependencyDigest === binding.candidate.digest,
    );
  const passed = unchanged && results.length > 0 && results.every((x) => x.passed);
  return {
    issueNumber,
    headSha: head,
    diffSha256: captured.diffSha256,
    passed,
    commands: results,
    beforeStatusSha256: captured.statusSha256,
    afterStatusSha256: after.statusSha256,
    unchanged,
    decision: passed ? "pass" : "fail",
    summary:
      "Every focused/global command ran in its own credential-free, network-denied disposable macOS sandbox copy; per-command complete head/status/digest evidence and cleanup were re-proved.",
  };
}
export function commitCandidate(
  issueNumber: number,
  issueIdentitySha256: string,
  base: string,
  cwd: string,
  proposal: Json,
  phase: "candidate-commit" | "landing-amend" = "candidate-commit",
  iteration = 0,
  envelope: string[] = proposal.envelope ?? [],
) {
  const before = evidence(issueNumber, base, cwd);
  const proposedStage = Array.isArray(proposal.stagePaths) ? proposal.stagePaths : [];
  const proposedChanged = Array.isArray(proposal.changedPaths) ? proposal.changedPaths : [];
  const originalHead = before.headSha;
  const sourceProofId = candidateEvidenceProof(
    { number: issueNumber, identitySha256: issueIdentitySha256 },
    before,
    envelope,
    phase,
    iteration,
  );
  const sourceApprovalId = lunaApprovalProof(proposal);
  const commitMessageSha256 = sha256(String(proposal.commitMessage ?? "").trimEnd());
  const restore = () => {
    return cleanLaneResidue(cwd, originalHead);
  };
  const fail = (reason: string) => {
    const restoredClean = restore();
    const restored = evidence(issueNumber, base, cwd);
    return {
      issueNumber,
      issueIdentitySha256,
      baseSha: base,
      parentSha: base,
      preCommitHeadSha: originalHead,
      commitSha: restored.headSha,
      headSha: restored.headSha,
      diffSha256: restored.diffSha256,
      patchId: restored.patchId,
      envelope,
      approvalPhase: phase,
      approvalIteration: iteration,
      sourceApprovalId,
      proofId: "",
      commitMessageSha256,
      decision: "reject" as const,
      exactlyOneCommit: false,
      clean: restoredClean,
      exactStagePaths: JSON.stringify(before.stagePaths) === JSON.stringify(proposedStage),
      exactChangedPaths: false,
      protectedPathClean: protectedPaths(restored.changedPaths).length === 0,
      messageValid: false,
      changedPaths: restored.changedPaths,
      failure: `${reason}; rollback clean=${restoredClean}`,
    };
  };
  const bound =
    proposal.issueNumber === issueNumber &&
    proposal.issueIdentitySha256 === issueIdentitySha256 &&
    proposal.baseSha === base &&
    proposal.headSha === before.headSha &&
    proposal.diffSha256 === before.diffSha256 &&
    proposal.patchId === before.patchId &&
    proposal.approvalPhase === phase &&
    proposal.sourceProofId === sourceProofId &&
    proposal.approvalIteration === iteration &&
    proposal.decision === "propose" &&
    JSON.stringify(proposal.envelope ?? []) === JSON.stringify(envelope);
  if (
    !bound ||
    !proposal.valid ||
    before.tooLarge ||
    before.stagePaths.length === 0 ||
    JSON.stringify(before.stagePaths) !== JSON.stringify(proposedStage) ||
    JSON.stringify(before.changedPaths) !== JSON.stringify(proposedChanged) ||
    !pathsWithinEnvelope(before.changedPaths, envelope) ||
    protectedPaths(before.changedPaths).length ||
    !exactCommitMessage(String(proposal.commitMessage ?? ""), issueNumber)
  )
    return fail(
      "Luna exact issue/head/digest/patch/ordered paths/envelope/iteration, size, protection, or target-only message did not match mechanical evidence",
    );
  const reset = git(["reset", "--mixed", "--quiet", "HEAD"], cwd);
  if (!reset.ok || git(["diff", "--cached", "--quiet", "--"], cwd).ok !== true)
    return fail("could not begin with a clean index");
  const add = git(["add", "--", ...proposedStage], cwd);
  if (!add.ok) return fail("enumerated staging failed");
  const count = Number(value(git(["rev-list", "--count", `${base}..HEAD`], cwd)) || "0");
  const commitArgs = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit"];
  const action =
    count === 0
      ? git([...commitArgs, "-m", proposal.commitMessage], cwd)
      : count === 1
        ? git([...commitArgs, "--amend", "-m", proposal.commitMessage], cwd)
        : { ...run(["false"]), stderr: "more than one lane commit" };
  if (!action.ok) return fail(action.stderr || "commit failed");
  const head = value(git(["rev-parse", "HEAD"], cwd));
  const finalPaths = changedPaths(base, cwd);
  const message = value(git(["log", "-1", "--format=%B"], cwd));
  const exactlyOne = value(git(["rev-list", "--count", `${base}..${head}`], cwd)) === "1";
  const residueClean = cleanLaneResidue(cwd, head);
  const final = evidence(issueNumber, base, cwd);
  let intrinsic: Json | undefined;
  try {
    intrinsic = exactCommitTuple(cwd, issueNumber, head);
  } catch {
    intrinsic = undefined;
  }
  const exactTuple =
    value(git(["rev-parse", "HEAD"], cwd)) === head &&
    JSON.stringify(changedPaths(base, cwd)) === JSON.stringify(finalPaths) &&
    intrinsic?.parentSha === base &&
    intrinsic?.headSha === head &&
    intrinsic?.diffSha256 === final.diffSha256 &&
    intrinsic?.patchId === final.patchId &&
    JSON.stringify(intrinsic?.changedPaths) === JSON.stringify(finalPaths) &&
    intrinsic?.commitMessageSha256 === sha256(message);
  const clean = residueClean && residueStatus(cwd) === "";
  const exactChanged = JSON.stringify(finalPaths) === JSON.stringify(proposedChanged);
  const messageValid = exactCommitMessage(message, issueNumber);
  const protectedPathClean = protectedPaths(finalPaths).length === 0;
  const proven =
    exactlyOne &&
    clean &&
    exactTuple &&
    exactChanged &&
    final.diffSha256 === before.diffSha256 &&
    final.diffSha256 === proposal.diffSha256 &&
    final.patchId === before.patchId &&
    final.patchId === proposal.patchId &&
    message === String(proposal.commitMessage).trimEnd() &&
    messageValid &&
    protectedPathClean;
  if (!proven)
    return fail(
      "post-commit one-commit/tree/path/protection/exact-message proof failed and the pre-commit candidate was restored",
    );
  const proof = {
    issueNumber,
    issueIdentitySha256,
    baseSha: base,
    parentSha: base,
    preCommitHeadSha: originalHead,
    commitSha: head,
    headSha: head,
    diffSha256: final.diffSha256,
    patchId: final.patchId,
    envelope,
    approvalPhase: phase,
    approvalIteration: iteration,
    sourceApprovalId,
    commitMessageSha256: sha256(message),
    decision: "committed" as const,
    exactlyOneCommit: true,
    clean: true,
    exactStagePaths: true,
    exactChangedPaths: true,
    protectedPathClean: true,
    messageValid: true,
    changedPaths: finalPaths,
    failure: "",
  };
  return { ...proof, proofId: commitProofIdentifier(proof) };
}

function orderedEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function candidateProofIdValid(proof: Json | undefined): boolean {
  if (!proof || !isNonBlank(proof.proofId)) return false;
  if (proof.approvalPhase === "candidate-commit" || proof.approvalPhase === "landing-amend")
    return proof.proofId === commitProofIdentifier(proof) && proof.decision === "committed";
  return proof.proofId === rebaseProofIdentifier(proof) && proof.decision === "review";
}

function candidateProofParent(proof: Json | undefined): string {
  return proof?.approvalPhase ? String(proof.parentSha ?? "") : String(proof?.newBaseSha ?? "");
}

function candidateProofHead(proof: Json | undefined): string {
  return proof?.approvalPhase ? String(proof.commitSha ?? "") : String(proof?.headSha ?? "");
}

function lsRemoteMain(cwd: string): { result: Cmd; sha: string } {
  const remote = canonicalRemoteConfiguration(cwd);
  const result = remote.ok
    ? networkGit(["ls-remote", "--exit-code", remote.fetchUrl, "refs/heads/main"], cwd)
    : denied(
        ["git", "ls-remote"],
        "origin must have exactly one canonical HTTPS fetch URL and push URL with safe local transport config",
      );
  const sha = result.ok ? (result.stdout.trim().split(/\s+/)[0] ?? "") : "";
  return { result, sha: /^\p{ASCII_Hex_Digit}{40,64}$/v.test(sha) ? sha : "" };
}

export function exactRemoteMainBoundary(cwd: string, expectedSha: string) {
  const canonicalBefore = canonicalOrigin(cwd);
  const fetch = canonicalBefore
    ? fetchCanonicalMain(cwd)
    : denied(["git", "fetch"], "canonical remote precondition failed");
  const fetchedSha = fetch.ok ? remoteSha(cwd) : "";
  const boundary = fetch.ok
    ? lsRemoteMain(cwd)
    : { result: denied(["git", "ls-remote"], "canonical fetch failed"), sha: "" };
  const canonical = canonicalBefore && canonicalOrigin(cwd);
  const ok = canonical && fetch.ok && boundary.result.ok && exactRemoteTipProven(expectedSha, fetchedSha, boundary.sha);
  return {
    ok,
    canonical,
    fetchExitCode: fetch.exitCode,
    lsRemoteExitCode: boundary.result.exitCode,
    fetchedSha,
    lsRemoteSha: boundary.sha,
  };
}

export function exactRemoteTipProven(expectedSha: string, fetchedSha: string, lsRemoteSha: string): boolean {
  return /^\p{ASCII_Hex_Digit}{40,64}$/v.test(expectedSha) && fetchedSha === expectedSha && lsRemoteSha === expectedSha;
}

function intrinsicMatches(tuple: Json | undefined, expected: Json): boolean {
  return (
    !!tuple &&
    tuple.issueNumber === expected.issueNumber &&
    tuple.parentSha === expected.parentSha &&
    tuple.headSha === expected.headSha &&
    tuple.diffSha256 === expected.diffSha256 &&
    tuple.patchId === expected.patchId &&
    tuple.commitMessageSha256 === expected.commitMessageSha256 &&
    orderedEqual(tuple.changedPaths, expected.changedPaths)
  );
}

function withPublicationProof(row: Json): Json {
  return { ...row, proofId: publicationProofIdentifier(row) };
}

function recoverPublication(
  n: number,
  issue: Json,
  cwd: string,
  admittedPaths: string[],
  rebase: Json,
  proposal: Json,
  candidate: Json,
): Json {
  const message = value(git(["log", "-1", "--format=%B", candidate.headSha], cwd));
  const landingApprovalId = lunaApprovalProof(proposal);
  const rebaseBound =
    isNonBlank(rebase.proofId) &&
    rebase.proofId === rebaseProofIdentifier(rebase) &&
    rebase.issueNumber === n &&
    rebase.issueIdentitySha256 === issue.identitySha256 &&
    orderedEqual(rebase.envelope, admittedPaths) &&
    rebase.headSha === candidate.headSha &&
    rebase.diffSha256 === candidate.diffSha256 &&
    rebase.patchId === candidate.patchId &&
    rebase.commitMessageSha256 === candidate.commitMessageSha256 &&
    orderedEqual(rebase.changedPaths, candidate.changedPaths);
  const proposalBound =
    proposal.issueNumber === n &&
    proposal.issueIdentitySha256 === issue.identitySha256 &&
    proposal.baseSha === rebase.newBaseSha &&
    proposal.headSha === candidate.headSha &&
    proposal.diffSha256 === candidate.diffSha256 &&
    proposal.patchId === candidate.patchId &&
    proposal.approvalPhase === "publication" &&
    proposal.sourceProofId === rebase.proofId &&
    proposal.approvalIteration === rebase.approvalIteration &&
    proposal.valid === true &&
    proposal.decision === "propose" &&
    Array.isArray(proposal.stagePaths) &&
    proposal.stagePaths.length === 0 &&
    orderedEqual(proposal.changedPaths, candidate.changedPaths) &&
    orderedEqual(proposal.envelope, admittedPaths) &&
    proposal.commitMessage === message &&
    exactCommitMessage(message, n);
  const fetch = fetchCanonicalMain(cwd);
  const fetchedRemote = remoteSha(cwd);
  const url = origin(cwd);
  const pushUrl = pushOrigin(cwd);
  const initialCanonical = canonicalOrigin(cwd);
  const fixes = fetch.ok ? matchingFixes(n, fetchedRemote, cwd) : ["QUERY-ERROR:fetch"];
  const equivalents = fetch.ok
    ? equivalentCommits(candidate.patchId, fetchedRemote, candidate.changedPaths, cwd)
    : ["QUERY-ERROR:fetch"];
  const queriesOk =
    !fixes.some((x) => x.startsWith("QUERY-ERROR:")) && !equivalents.some((x) => x.startsWith("QUERY-ERROR:"));
  const collision = activeCollisionPaths(candidate.changedPaths, cwd);
  let tuple: Json | undefined;
  try {
    tuple = authorizeClosureRecovery(
      cwd,
      {
        issueNumber: n,
        headSha: candidate.headSha,
        diffSha256: candidate.diffSha256,
        patchId: candidate.patchId,
        changedPaths: candidate.changedPaths,
      },
      admittedPaths,
    );
  } catch {
    tuple = undefined;
  }
  const currentIssue = fetchIssue(n);
  const remoteBoundary = lsRemoteMain(cwd);
  const canonical = initialCanonical && canonicalOrigin(cwd);
  const identityMatches = currentIssue?.identitySha256 === issue.identitySha256;
  const provenanceMatches =
    rebaseBound &&
    proposalBound &&
    intrinsicMatches(tuple, {
      issueNumber: n,
      parentSha: rebase.newBaseSha,
      headSha: candidate.headSha,
      diffSha256: candidate.diffSha256,
      patchId: candidate.patchId,
      changedPaths: candidate.changedPaths,
      commitMessageSha256: sha256(message),
    }) &&
    pathsWithinEnvelope(tuple?.changedPaths ?? [], admittedPaths);
  const equivalenceConsistent =
    queriesOk && fixes.includes(candidate.headSha) && equivalents.includes(candidate.headSha);
  const remoteStable =
    fetch.ok &&
    remoteBoundary.result.ok &&
    fetchedRemote === candidate.headSha &&
    remoteBoundary.sha === candidate.headSha;
  const liveState = {
    provenanceKind: "recovery",
    sourceRebaseProofId: rebase.proofId,
    landingApprovalId,
    issueNumber: n,
    issueIdentitySha256: issue.identitySha256,
    remoteSha: fetchedRemote,
    lsRemoteSha: remoteBoundary.sha,
    issueState: currentIssue?.state ?? "missing",
    liveIssueIdentitySha256: currentIssue?.identitySha256 ?? "",
    canonicalOrigin: canonical,
    collisionOk: collision.ok,
    collisions: collision.collisions,
    fixes,
    equivalents,
    queriesOk,
    clean: residueStatus(cwd) === "",
    commitSha: candidate.headSha,
    parentSha: tuple?.parentSha ?? "",
    diffSha256: candidate.diffSha256,
    patchId: candidate.patchId,
    changedPaths: candidate.changedPaths,
    envelope: admittedPaths,
    commitMessageSha256: sha256(message),
    approvalIteration: rebase.approvalIteration,
  };
  const liveStateId = publicationLiveStateId(liveState);
  const proven =
    remoteStable &&
    canonical &&
    identityMatches &&
    currentIssue?.state === "open" &&
    provenanceMatches &&
    collision.ok &&
    collision.collisions.length === 0 &&
    equivalenceConsistent &&
    liveState.clean;
  const row = {
    issueNumber: n,
    provenanceKind: "recovery" as const,
    issueIdentitySha256: issue.identitySha256,
    envelope: admittedPaths,
    sourceRebaseProofId: rebase.proofId,
    landingApprovalId,
    liveStateId,
    commitSha: candidate.headSha,
    candidateParentSha: tuple?.parentSha ?? "",
    commitMessageSha256: sha256(message),
    diffSha256: candidate.diffSha256,
    patchId: candidate.patchId,
    changedPaths: candidate.changedPaths,
    approvalIteration: rebase.approvalIteration,
    provenanceMatches,
    collisionEvidenceOk: collision.ok && queriesOk,
    pushed: false,
    reachable: proven,
    alreadyReachable: proven,
    retryableRace: false,
    fetchExitCode: fetch.exitCode,
    prePushRemoteSha: remoteBoundary.sha,
    postPushRemoteSha: remoteBoundary.sha,
    remoteBaseSha: fetchedRemote,
    originUrl: url,
    pushUrl,
    canonicalOrigin: canonical,
    issueIdentityMatches: identityMatches,
    equivalenceConsistent,
    decision: proven ? ("reachable" as const) : ("defer" as const),
    summary: proven
      ? "Current-run rebase and Luna approval plus exact-tip remote/issue/collision/equivalence evidence authorize closure without another push."
      : "Current-run publication recovery proof failed closed; no push or GitHub mutation ran.",
  };
  return withPublicationProof(row);
}

function publishCandidate(
  n: number,
  issue: Json,
  cwd: string,
  admittedPaths: string[],
  iteration: number,
  rebase: Json,
  candidate: Json,
  proposal: Json,
): Json {
  const message = value(git(["log", "-1", "--format=%B", candidate.headSha], cwd));
  const landingApprovalId = lunaApprovalProof(proposal);
  const rebaseBound =
    isNonBlank(rebase.proofId) &&
    rebase.proofId === rebaseProofIdentifier(rebase) &&
    rebase.issueNumber === n &&
    rebase.issueIdentitySha256 === issue.identitySha256 &&
    rebase.approvalIteration === iteration &&
    orderedEqual(rebase.envelope, admittedPaths);
  const proposalBound =
    proposal.issueNumber === n &&
    proposal.issueIdentitySha256 === issue.identitySha256 &&
    proposal.baseSha === rebase.newBaseSha &&
    proposal.headSha === candidate.headSha &&
    proposal.diffSha256 === candidate.diffSha256 &&
    proposal.patchId === candidate.patchId &&
    proposal.approvalPhase === "publication" &&
    proposal.sourceProofId === rebase.proofId &&
    proposal.approvalIteration === iteration &&
    proposal.valid === true &&
    proposal.decision === "propose" &&
    Array.isArray(proposal.stagePaths) &&
    proposal.stagePaths.length === 0 &&
    orderedEqual(proposal.changedPaths, candidate.changedPaths) &&
    orderedEqual(proposal.envelope, admittedPaths) &&
    proposal.commitMessage === message &&
    exactCommitMessage(message, n);
  const fetch = fetchCanonicalMain(cwd);
  const fetchedRemote = remoteSha(cwd);
  const fixes = fetch.ok ? matchingFixes(n, fetchedRemote, cwd) : ["QUERY-ERROR:fetch"];
  const equivalents = fetch.ok
    ? equivalentCommits(candidate.patchId, fetchedRemote, candidate.changedPaths, cwd)
    : ["QUERY-ERROR:fetch"];
  const queriesOk =
    !fixes.some((x) => x.startsWith("QUERY-ERROR:")) && !equivalents.some((x) => x.startsWith("QUERY-ERROR:"));
  const collision = activeCollisionPaths(candidate.changedPaths, cwd);
  let tuple: Json | undefined;
  try {
    tuple = exactCommitTuple(cwd, n, candidate.headSha);
  } catch {
    tuple = undefined;
  }
  const recaptured = evidence(n, rebase.newBaseSha, cwd);
  const url = origin(cwd);
  const pushUrl = pushOrigin(cwd);
  const canonical = canonicalOrigin(cwd);
  const residueClean = residueStatus(cwd) === "";
  const finalIssue = fetchIssue(n);
  const identityMatches = finalIssue?.identitySha256 === issue.identitySha256;
  const intrinsicBound = intrinsicMatches(tuple, {
    issueNumber: n,
    parentSha: rebase.newBaseSha,
    headSha: candidate.headSha,
    diffSha256: candidate.diffSha256,
    patchId: candidate.patchId,
    changedPaths: candidate.changedPaths,
    commitMessageSha256: sha256(message),
  });
  const candidateStable =
    recaptured.headSha === candidate.headSha &&
    recaptured.diffSha256 === candidate.diffSha256 &&
    recaptured.patchId === candidate.patchId &&
    recaptured.statusSha256 === candidate.statusSha256 &&
    orderedEqual(recaptured.changedPaths, candidate.changedPaths) &&
    recaptured.clean;
  const provenanceMatches = rebaseBound && proposalBound && intrinsicBound && candidateStable;
  const equivalenceConsistent = queriesOk && fixes.length === 0 && equivalents.length === 0;
  const remoteBoundary = lsRemoteMain(cwd);
  const remoteStable =
    fetch.ok &&
    remoteBoundary.result.ok &&
    fetchedRemote === remoteBoundary.sha &&
    tuple?.parentSha === remoteBoundary.sha;
  const liveState = {
    provenanceKind: "normal",
    sourceRebaseProofId: rebase.proofId,
    landingApprovalId,
    issueNumber: n,
    issueIdentitySha256: issue.identitySha256,
    remoteSha: fetchedRemote,
    lsRemoteSha: remoteBoundary.sha,
    issueState: finalIssue?.state ?? "missing",
    liveIssueIdentitySha256: finalIssue?.identitySha256 ?? "",
    canonicalOrigin: canonical,
    collisionOk: collision.ok,
    collisions: collision.collisions,
    fixes,
    equivalents,
    queriesOk,
    clean: residueClean,
    commitSha: candidate.headSha,
    parentSha: tuple?.parentSha ?? "",
    diffSha256: candidate.diffSha256,
    patchId: candidate.patchId,
    changedPaths: candidate.changedPaths,
    envelope: admittedPaths,
    commitMessageSha256: sha256(message),
    approvalIteration: iteration,
  };
  const liveStateId = publicationLiveStateId(liveState);
  const publicationAuthorized = publicationBoundaryAuthorized({
    issueState: finalIssue?.state ?? "missing",
    collisionQueryOk: collision.ok && queriesOk,
    collisions: collision.collisions,
    provenanceMatches,
    canonicalRemote: canonical,
    proposalValid: proposal.valid === true,
    proposalDecision: proposal.decision,
    stagePaths: proposal.stagePaths,
  });
  const boundarySafe =
    remoteStable &&
    publicationAuthorized &&
    identityMatches &&
    equivalenceConsistent &&
    liveState.clean &&
    pathsWithinEnvelope(candidate.changedPaths, admittedPaths);
  const baseRow = {
    issueNumber: n,
    provenanceKind: "normal" as const,
    issueIdentitySha256: issue.identitySha256,
    envelope: admittedPaths,
    sourceRebaseProofId: rebase.proofId,
    landingApprovalId,
    liveStateId,
    commitSha: candidate.headSha,
    candidateParentSha: tuple?.parentSha ?? "",
    commitMessageSha256: sha256(message),
    diffSha256: candidate.diffSha256,
    patchId: candidate.patchId,
    changedPaths: candidate.changedPaths,
    approvalIteration: iteration,
    provenanceMatches,
    collisionEvidenceOk: collision.ok && queriesOk,
    pushed: false,
    reachable: false,
    alreadyReachable: false,
    retryableRace: false,
    fetchExitCode: fetch.exitCode,
    prePushRemoteSha: remoteBoundary.sha,
    postPushRemoteSha: fetchedRemote,
    remoteBaseSha: fetchedRemote,
    originUrl: url,
    pushUrl,
    canonicalOrigin: canonical,
    issueIdentityMatches: identityMatches,
    equivalenceConsistent,
    decision: "defer" as "published" | "reachable" | "retry" | "defer",
    summary:
      "Final publication boundary denied stale or incomplete causal, remote, issue, collision, equivalence, residue, or path evidence.",
  };
  if (!boundarySafe) return withPublicationProof(baseRow);
  // This is intentionally adjacent to the final ls-remote read above. A racing update makes the normal non-force push fail.
  const push = pushCanonicalMain(cwd, candidate.headSha);
  const postBoundary = exactRemoteMainBoundary(cwd, candidate.headSha);
  const reachable = push.ok && postBoundary.ok;
  const row = {
    ...baseRow,
    pushed: push.ok,
    reachable,
    retryableRace: !push.ok || !reachable,
    fetchExitCode: postBoundary.fetchExitCode,
    postPushRemoteSha: postBoundary.lsRemoteSha,
    remoteBaseSha: postBoundary.fetchedSha,
    canonicalOrigin: postBoundary.canonical,
    decision: reachable ? ("published" as const) : ("retry" as const),
    summary: reachable
      ? "Normal non-force exact-SHA push passed and both fresh remote-main reads equal the candidate SHA."
      : "The push failed, remote main no longer equals the candidate SHA, or publication verification failed; retry requires a fresh current-run rebase proof and Luna approval.",
  };
  return withPublicationProof(row);
}

function refreshClosure(
  n: number,
  issue: Json,
  cwd: string,
  admittedPaths: string[],
  publication: Json,
  closureAttempt: number,
): Json {
  const marker = stableOperationMarker(CANONICAL_REPOSITORY, n, publication.commitSha);
  const publicationBound = publicationCausalChainValid(publication, n, issue.identitySha256, admittedPaths);
  const initialIssue = fetchIssue(n);
  const comments = paginatedGithub(`repos/${CANONICAL_REPOSITORY}/issues/${n}/comments`);
  const commentsEnumerated = comments.ok;
  const markerPresent =
    commentsEnumerated && comments.pages.flat().some((x: Json) => String(x.body ?? "").includes(marker));
  let tuple: Json | undefined;
  try {
    tuple = exactCommitTuple(cwd, n, publication.commitSha);
  } catch {
    tuple = undefined;
  }
  const provenanceMatches =
    intrinsicMatches(tuple, {
      issueNumber: n,
      parentSha: publication.candidateParentSha,
      headSha: publication.commitSha,
      diffSha256: publication.diffSha256,
      patchId: publication.patchId,
      changedPaths: publication.changedPaths,
      commitMessageSha256: publication.commitMessageSha256,
    }) && pathsWithinEnvelope(tuple?.changedPaths ?? [], admittedPaths);
  const currentIssue = fetchIssue(n);
  const boundary = exactRemoteMainBoundary(cwd, publication.commitSha);
  const remoteMainSha = boundary.lsRemoteSha || boundary.fetchedSha;
  const identityMatches =
    initialIssue?.identitySha256 === issue.identitySha256 && currentIssue?.identitySha256 === issue.identitySha256;
  const issueState = currentIssue?.state ?? "missing";
  const ready =
    publicationBound &&
    boundary.ok &&
    identityMatches &&
    commentsEnumerated &&
    provenanceMatches &&
    residueStatus(cwd) === "";
  const row = {
    issueNumber: n,
    sourcePublicationProofId: publication.proofId,
    issueIdentitySha256: issue.identitySha256,
    commitMessageSha256: publication.commitMessageSha256,
    remoteMainSha,
    headSha: publication.commitSha,
    diffSha256: publication.diffSha256,
    patchId: tuple?.patchId ?? publication.patchId,
    changedPaths: tuple?.changedPaths ?? publication.changedPaths,
    approvalIteration: publication.approvalIteration,
    envelope: admittedPaths,
    closureAttempt,
    ready,
    fetchExitCode: boundary.fetchExitCode,
    canonicalOrigin: boundary.canonical,
    reachable: boundary.ok,
    issueState,
    identityMatches,
    commentsEnumerated,
    markerPresent,
    operationMarker: marker,
    decision: ready ? ("authorize" as const) : ("defer" as const),
    summary: ready
      ? "Fresh publication proof, exact remote-main tip, immutable identity, exact commit tuple, and complete comment enumeration authorize closure review."
      : "Closure refresh failed closed before Luna or mutation.",
  };
  return { ...row, proofId: closureRefreshProofIdentifier(row) };
}

function withClosureProof(row: Json): Json {
  return { ...row, proofId: closureProofIdentifier(row) };
}

function alreadyClosedClosure(
  n: number,
  issue: Json,
  cwd: string,
  admittedPaths: string[],
  publication: Json,
  refresh: Json,
): Json {
  const currentIssue = fetchIssue(n);
  const boundary = exactRemoteMainBoundary(cwd, refresh.headSha);
  const identityMatches = currentIssue?.identitySha256 === issue.identitySha256;
  const sourceChain =
    publicationCausalChainValid(publication, n, issue.identitySha256, admittedPaths) &&
    refresh?.sourcePublicationProofId === publication.proofId &&
    refresh?.proofId === closureRefreshProofIdentifier(refresh) &&
    refresh?.ready === true &&
    refresh?.issueState === "closed";
  const closed = sourceChain && boundary.ok && identityMatches && currentIssue?.state === "closed";
  const row = {
    issueNumber: n,
    sourcePublicationProofId: publication.proofId,
    sourceClosureRefreshId: refresh.proofId,
    sourceCloseApprovalId: "",
    sha: refresh.headSha,
    reachable: boundary.ok,
    identityMatches,
    commentPosted: false,
    duplicateCommentAvoided: refresh.markerPresent,
    closed,
    idempotent: true,
    decision: closed ? ("closed" as const) : ("defer" as const),
    summary: closed
      ? "Fresh closure proof found the immutable issue already closed while the exact publication SHA remained remote main."
      : "The already-closed path lost its exact remote tip, immutable identity, or causal proof and failed closed.",
  };
  return withClosureProof(row);
}

function executeClosure(
  n: number,
  issue: Json,
  cwd: string,
  admittedPaths: string[],
  publication: Json,
  refresh: Json,
  close: Json,
): Json {
  const sourceCloseApprovalId = closeApprovalProof(close);
  const sourceChain =
    publicationCausalChainValid(publication, n, issue.identitySha256, admittedPaths) &&
    refresh?.sourcePublicationProofId === publication.proofId &&
    refresh?.proofId === closureRefreshProofIdentifier(refresh) &&
    refresh?.ready === true &&
    close?.sourceClosureRefreshId === refresh.proofId &&
    close?.issueNumber === n &&
    close?.decision === "close" &&
    isNonBlank(sourceCloseApprovalId);
  const marker = stableOperationMarker(CANONICAL_REPOSITORY, n, close.headSha);
  const commentsResult = paginatedGithub(`repos/${CANONICAL_REPOSITORY}/issues/${n}/comments`);
  const enumerated = commentsResult.ok;
  const duplicate = enumerated && commentsResult.pages.flat().some((x: Json) => String(x.body ?? "").includes(marker));
  let tuple: Json | undefined;
  try {
    tuple = exactCommitTuple(cwd, n, close.headSha);
  } catch {
    tuple = undefined;
  }
  const exactClosureTuple =
    intrinsicMatches(tuple, {
      issueNumber: n,
      parentSha: publication.candidateParentSha,
      headSha: close.headSha,
      diffSha256: close.diffSha256,
      patchId: close.patchId,
      changedPaths: close.changedPaths,
      commitMessageSha256: publication.commitMessageSha256,
    }) && orderedEqual(close.envelope, admittedPaths);
  const currentIssue = fetchIssue(n);
  const initialBoundary = exactRemoteMainBoundary(cwd, close.headSha);
  const identityMatches = currentIssue?.identitySha256 === issue.identitySha256;
  const base = {
    issueNumber: n,
    sourcePublicationProofId: publication.proofId,
    sourceClosureRefreshId: refresh.proofId,
    sourceCloseApprovalId,
    sha: close.headSha,
    reachable: initialBoundary.ok,
    identityMatches,
    commentPosted: false,
    duplicateCommentAvoided: duplicate,
    closed: false,
    idempotent: false,
    decision: "defer" as "closed" | "blocked" | "defer",
    summary:
      "Fresh causal chain, exact remote-main tip, immutable identity, exact commit tuple, marker, or comment enumeration failed; no GitHub mutation ran.",
  };
  if (
    !sourceChain ||
    !initialBoundary.ok ||
    !currentIssue ||
    !identityMatches ||
    !enumerated ||
    marker !== close.operationMarker ||
    !close.comment.includes(close.headSha) ||
    !exactClosureTuple ||
    sourceCloseApprovalId !== closeApprovalProof(close)
  )
    return withClosureProof(base);
  if (currentIssue.state === "closed")
    return withClosureProof({
      ...base,
      closed: true,
      idempotent: true,
      decision: "closed" as const,
      summary:
        "The exact issue was already closed and a fresh boundary still proved the publication SHA is remote main.",
    });
  const body = `${close.comment.trim()}\n\n${marker}`;
  const preCommentIssue = duplicate ? currentIssue : fetchIssue(n);
  const preCommentIdentity = preCommentIssue?.identitySha256 === issue.identitySha256;
  const preCommentBoundary = duplicate ? initialBoundary : exactRemoteMainBoundary(cwd, close.headSha);
  if (
    !duplicate &&
    (!preCommentIssue || preCommentIssue.state !== "open" || !preCommentIdentity || !preCommentBoundary.ok)
  )
    return withClosureProof({
      ...base,
      reachable: preCommentBoundary.ok,
      identityMatches: preCommentIdentity,
      summary:
        "Immutable issue identity/state or the exact remote-main tip changed immediately before comment; no GitHub mutation ran.",
    });
  const comment = duplicate ? { ok: true } : runPinnedGithub(["issue", "comment", String(n), "--body", body]);
  const preCloseIssue = comment.ok ? fetchIssue(n) : null;
  const preCloseIdentity = preCloseIssue?.identitySha256 === issue.identitySha256;
  const preCloseBoundary =
    comment.ok && preCloseIssue && preCloseIdentity
      ? exactRemoteMainBoundary(cwd, close.headSha)
      : { ...initialBoundary, ok: false };
  if (!comment.ok || !preCloseIssue || !preCloseIdentity || !preCloseBoundary.ok)
    return withClosureProof({
      ...base,
      reachable: preCloseBoundary.ok,
      identityMatches: preCloseIdentity,
      commentPosted: !duplicate && comment.ok,
      duplicateCommentAvoided: duplicate,
      summary:
        "The comment step failed, immutable issue identity changed, or exact remote main moved before close; no close mutation ran.",
    });
  if (preCloseIssue.state === "closed")
    return withClosureProof({
      ...base,
      reachable: true,
      commentPosted: !duplicate && comment.ok,
      duplicateCommentAvoided: duplicate,
      closed: true,
      idempotent: true,
      decision: "closed" as const,
      summary:
        "The exact issue auto-closed after comment and a fresh boundary still proved the publication SHA is remote main.",
    });
  const closeResult = runPinnedGithub(["issue", "close", String(n)]);
  const verified = fetchIssue(n);
  const finalBoundary = exactRemoteMainBoundary(cwd, close.headSha);
  const closed =
    closeResult.ok &&
    finalBoundary.ok &&
    verified?.state === "closed" &&
    verified.identitySha256 === issue.identitySha256;
  const row = {
    ...base,
    reachable: finalBoundary.ok,
    identityMatches: verified?.identitySha256 === issue.identitySha256,
    commentPosted: !duplicate && comment.ok,
    duplicateCommentAvoided: duplicate,
    closed,
    idempotent: duplicate,
    decision: closed ? ("closed" as const) : ("blocked" as const),
    summary: closed
      ? "Exact Luna-authorized comment/close operation is verified against immutable identity and a post-close exact remote-main boundary."
      : "Comment or close failed, final immutable closed state was not verified, or remote main stopped equaling the publication SHA.",
  };
  return withClosureProof(row);
}

function correctionLane(
  n: number,
  issue: Json,
  base: string,
  cwd: string,
  maxIterations: number,
  ctx: any,
  admittedPaths: string[],
) {
  const loopId = `i${n}:correction-loop`;
  const iteration = ctx.iterations?.[loopId] ?? 0;
  const attempt = current<Json>(ctx, outputs.candidateEvidence, `i${n}:attempt-evidence`, iteration);
  const sol = current<Json>(ctx, outputs.solImplement, `i${n}:sol-implement`, iteration);
  const protection = current<Json>(ctx, outputs.protection, `i${n}:protection`, iteration);
  const proposal = current<Json>(ctx, outputs.lunaProposal, `i${n}:luna-proposal`, iteration);
  const commit = current<Json>(ctx, outputs.commitProof, `i${n}:commit`, iteration);
  const before = current<Json>(ctx, outputs.candidateEvidence, `i${n}:review-evidence`, iteration);
  const review = current<Json>(ctx, outputs.fableReview, `i${n}:fable-review`, iteration);
  const after = current<Json>(ctx, outputs.evidenceCheck, `i${n}:review-check`, iteration);
  const gates = current<Json>(ctx, outputs.gates, `i${n}:candidate-gates`, iteration);
  const ready = current<Json>(ctx, outputs.laneReadiness, `i${n}:lane-readiness`, iteration);
  const prior =
    iteration > 0 ? current<Json>(ctx, outputs.laneReadiness, `i${n}:lane-readiness`, iteration - 1) : undefined;
  return (
    <Loop id={loopId} maxIterations={maxIterations} until={ready?.ready === true} onMaxReached="return-last">
      <Sequence>
        <Task id={`i${n}:attempt-evidence`} output={outputs.candidateEvidence}>
          {() => evidence(n, base, cwd)}
        </Task>
        {attempt && !attempt.tooLarge ? (
          <Branch
            if
            then={
              <Task
                id={`i${n}:sol-implement`}
                output={outputs.solImplement}
                agent={codex("gpt-5.6-sol", "write", cwd)}
                continueOnFail
              >
                <SolPrompt
                  issue={issue}
                  candidate={attempt}
                  iteration={iteration}
                  attempt={iteration + 1}
                  previousFeedback={prior?.feedback ?? []}
                />
              </Task>
            }
          />
        ) : null}
        {sol &&
        attempt &&
        sol.issueNumber === n &&
        sol.headSha === attempt.headSha &&
        sol.diffSha256 === attempt.diffSha256 &&
        ["implement", "correct"].includes(sol.decision) ? (
          <Branch
            if
            then={
              <Task id={`i${n}:protection`} output={outputs.protection}>
                {() => {
                  const e = evidence(n, base, cwd);
                  const envelopeClean = pathsWithinEnvelope(e.changedPaths, admittedPaths);
                  const violations = [
                    ...protectedPaths(e.changedPaths),
                    ...(!envelopeClean
                      ? e.changedPaths
                          .filter((path: string) => !pathsWithinEnvelope([path], admittedPaths))
                          .map((path: string) => `unexpected:${path}`)
                      : []),
                  ];
                  return {
                    issueNumber: n,
                    headSha: e.headSha,
                    diffSha256: e.diffSha256,
                    passed: e.changedPaths.length > 0 && !e.tooLarge && violations.length === 0,
                    violations,
                    changedPaths: e.changedPaths,
                    stagePaths: e.stagePaths,
                    tooLarge: e.tooLarge,
                    decision: violations.length || e.tooLarge ? "reject" : "pass",
                    evidence: e.completePatch,
                  };
                }}
              </Task>
            }
          />
        ) : null}
        {protection?.passed === true ? (
          <Branch
            if
            then={
              <Sequence>
                <Task
                  id={`i${n}:luna-proposal`}
                  output={outputs.lunaProposal}
                  agent={codex("gpt-5.6-luna", "read", cwd)}
                  continueOnFail
                >
                  <LunaCommitPrompt
                    issue={issue}
                    issueIdentitySha256={issue.identitySha256}
                    baseSha={base}
                    candidate={evidence(n, base, cwd)}
                    iteration={iteration}
                    envelope={admittedPaths}
                    approvalPhase="candidate-commit"
                    sourceProofId={candidateEvidenceProof(
                      issue,
                      evidence(n, base, cwd),
                      admittedPaths,
                      "candidate-commit",
                      iteration,
                    )}
                  />
                </Task>
                {proposal?.valid === true &&
                proposal.issueNumber === n &&
                proposal.issueIdentitySha256 === issue.identitySha256 &&
                proposal.headSha === protection.headSha &&
                proposal.diffSha256 === protection.diffSha256 &&
                proposal.approvalIteration === iteration &&
                proposal.approvalPhase === "candidate-commit" &&
                proposal.decision === "propose" ? (
                  <Branch
                    if
                    then={
                      <Task id={`i${n}:commit`} output={outputs.commitProof}>
                        {() =>
                          commitCandidate(
                            n,
                            issue.identitySha256,
                            base,
                            cwd,
                            proposal,
                            "candidate-commit",
                            iteration,
                            admittedPaths,
                          )
                        }
                      </Task>
                    }
                  />
                ) : null}
                {commit?.exactlyOneCommit === true && commit.clean === true && commit.protectedPathClean === true ? (
                  <Branch
                    if
                    then={
                      <Sequence>
                        <Task id={`i${n}:review-evidence`} output={outputs.candidateEvidence}>
                          {() => evidence(n, base, cwd)}
                        </Task>
                        {before && !before.tooLarge ? (
                          <Branch
                            if
                            then={
                              <Sequence>
                                <Task
                                  id={`i${n}:fable-review`}
                                  output={outputs.fableReview}
                                  agent={fable(cwd)}
                                  continueOnFail
                                >
                                  <FablePrompt issue={issue} candidate={before} phase="candidate" />
                                </Task>
                                <Task id={`i${n}:review-check`} output={outputs.evidenceCheck}>
                                  {() => {
                                    const now = evidence(n, base, cwd);
                                    const reviewBound =
                                      review?.issueNumber === n &&
                                      review?.decision === "approve" &&
                                      review?.approved === true &&
                                      review?.headSha === before.headSha &&
                                      review?.diffSha256 === before.diffSha256 &&
                                      isNonBlank(review.summary) &&
                                      nonBlankStrings(review.acceptanceEvidence);
                                    const passed =
                                      reviewBound &&
                                      now.headSha === before.headSha &&
                                      now.diffSha256 === before.diffSha256 &&
                                      now.statusSha256 === before.statusSha256 &&
                                      now.clean &&
                                      pathsWithinEnvelope(now.changedPaths, admittedPaths) &&
                                      protectedPaths(now.changedPaths).length === 0;
                                    return {
                                      issueNumber: n,
                                      headSha: now.headSha,
                                      diffSha256: now.diffSha256,
                                      passed,
                                      protectedPathClean: protectedPaths(now.changedPaths).length === 0,
                                      clean: now.clean,
                                      decision: passed ? "bound" : "reject",
                                      summary:
                                        "Controller re-captured exact head, complete digest, status, admitted paths, and trimmed nonblank issue/decision-bound Fable evidence.",
                                    };
                                  }}
                                </Task>
                                {review?.issueNumber === n &&
                                review?.decision === "approve" &&
                                review?.approved === true &&
                                review.headSha === before.headSha &&
                                review.diffSha256 === before.diffSha256 &&
                                after?.passed === true ? (
                                  <Branch
                                    if
                                    then={
                                      <Task id={`i${n}:candidate-gates`} output={outputs.gates}>
                                        {() => runGates(n, base, before.headSha, cwd, before.changedPaths)}
                                      </Task>
                                    }
                                  />
                                ) : null}
                              </Sequence>
                            }
                          />
                        ) : null}
                      </Sequence>
                    }
                  />
                ) : null}
              </Sequence>
            }
          />
        ) : null}
        <Task id={`i${n}:lane-readiness`} output={outputs.laneReadiness}>
          {() => {
            const gateFailures = (gates?.commands ?? [])
              .filter((command: Json) => !command.passed)
              .map(
                (command: Json) =>
                  `gate ${JSON.stringify(command.argv)} exit=${command.exitCode} timeout=${command.timedOut}: ${command.log}`,
              );
            const feedback = [
              ...(attempt?.tooLarge ? [attempt.summary] : []),
              ...(!sol ? ["Sol output absent for this iteration"] : sol.decision === "defer" ? [sol.summary] : []),
              ...(!protection
                ? ["protection output absent for this iteration"]
                : protection.passed === false
                  ? [`protection ${protection.decision}: ${protection.violations.join(", ") || protection.evidence}`]
                  : []),
              ...(!proposal
                ? ["Luna proposal absent for this iteration"]
                : proposal.valid === false
                  ? [`Luna: ${proposal.rationale}`]
                  : []),
              ...(commit?.failure
                ? [`commit proof: ${commit.failure}`]
                : !commit
                  ? ["commit proof absent for this iteration"]
                  : []),
              ...(!review ? ["Fable review absent for this iteration"] : review.findings),
              ...(after?.passed === false
                ? [`review binding: ${after.summary}`]
                : !after
                  ? ["review binding output absent for this iteration"]
                  : []),
              ...gateFailures,
              ...(gates?.passed === false
                ? [`gate controller: ${gates.summary}`]
                : !gates
                  ? ["candidate gate output absent for this iteration"]
                  : []),
            ];
            const commitProofBound =
              commit?.issueNumber === n &&
              commit?.issueIdentitySha256 === issue.identitySha256 &&
              commit?.approvalPhase === "candidate-commit" &&
              commit?.approvalIteration === iteration &&
              commit?.sourceApprovalId === lunaApprovalProof(proposal ?? {}) &&
              JSON.stringify(commit?.envelope) === JSON.stringify(admittedPaths) &&
              isNonBlank(commit?.proofId) &&
              commit.proofId === commitProofIdentifier(commit);
            const ok =
              protection?.passed === true &&
              commitProofBound &&
              commit?.exactlyOneCommit === true &&
              commit.clean === true &&
              commit.messageValid === true &&
              commit.protectedPathClean === true &&
              before &&
              commit.headSha === before.headSha &&
              commit.diffSha256 === before.diffSha256 &&
              commit.patchId === before.patchId &&
              JSON.stringify(commit.changedPaths) === JSON.stringify(before.changedPaths) &&
              pathsWithinEnvelope(before.changedPaths, admittedPaths) &&
              review?.issueNumber === n &&
              review?.decision === "approve" &&
              review.approved === true &&
              review.headSha === before.headSha &&
              review.diffSha256 === before.diffSha256 &&
              isNonBlank(review.summary) &&
              nonBlankStrings(review.acceptanceEvidence) &&
              after?.passed === true &&
              gates?.passed === true &&
              gates.headSha === before.headSha &&
              gates.diffSha256 === before.diffSha256;
            return {
              issueNumber: n,
              issueIdentitySha256: issue.identitySha256,
              headSha: before?.headSha ?? commit?.headSha ?? attempt?.headSha ?? base,
              diffSha256: before?.diffSha256 ?? commit?.diffSha256 ?? attempt?.diffSha256 ?? sha256(""),
              patchId: before?.patchId ?? commit?.patchId ?? attempt?.patchId ?? "missing",
              changedPaths: before?.changedPaths ?? commit?.changedPaths ?? attempt?.changedPaths ?? admittedPaths,
              envelope: admittedPaths,
              approvalIteration: iteration,
              sourceCommitProofId: commitProofBound ? commit.proofId : "",
              ready: ok,
              attempt: iteration + 1,
              decision: ok ? "ready" : "correct",
              feedback: feedback.filter(isNonBlank).length
                ? feedback.filter(isNonBlank)
                : ["current iteration lacks complete approval evidence"],
              summary: ok
                ? "Exact candidate and causal commit proof are ready for serialized landing."
                : "Bounded correction required from the recorded current-iteration evidence.",
            };
          }}
        </Task>
      </Sequence>
    </Loop>
  );
}

function landingSequence(n: number, issue: Json, cwd: string, retries: number, ctx: any, admittedPaths: string[]) {
  const bootstrap = fixed<Json>(ctx, outputs.laneBootstrap, `i${n}:lane-bootstrap`);
  const live = fixed<Json>(ctx, outputs.liveRefresh, `i${n}:live-refresh`);
  const correctionIteration = ctx.iterations?.[`i${n}:correction-loop`] ?? 0;
  const correction = current<Json>(ctx, outputs.laneReadiness, `i${n}:lane-readiness`, correctionIteration);
  const correctionProposal = current<Json>(ctx, outputs.lunaProposal, `i${n}:luna-proposal`, correctionIteration);
  const correctionCommit = current<Json>(ctx, outputs.commitProof, `i${n}:commit`, correctionIteration);
  const loopId = `i${n}:landing-loop`;
  const iteration = ctx.iterations?.[loopId] ?? 0;
  const refresh = current<Json>(ctx, outputs.landingRefresh, `i${n}:landing-refresh`, iteration);
  const rebase = current<Json>(ctx, outputs.rebaseProof, `i${n}:rebase`, iteration);
  const before = current<Json>(ctx, outputs.candidateEvidence, `i${n}:landing-evidence`, iteration);
  const review = current<Json>(ctx, outputs.fableReview, `i${n}:landing-review`, iteration);
  const check = current<Json>(ctx, outputs.evidenceCheck, `i${n}:landing-review-check`, iteration);
  const gates = current<Json>(ctx, outputs.gates, `i${n}:landing-gates`, iteration);
  const publicationProposal = current<Json>(ctx, outputs.lunaProposal, `i${n}:publication-luna-proposal`, iteration);
  const publication = current<Json>(ctx, outputs.publication, `i${n}:publication`, iteration);
  const finalPublication = publication;
  const closureLoopId = `i${n}:closure-loop`;
  const closureIteration = ctx.iterations?.[closureLoopId] ?? 0;
  const closureRefresh = current<Json>(ctx, outputs.closureRefresh, `i${n}:closure-refresh`, closureIteration);
  const close = current<Json>(ctx, outputs.closeProposal, `i${n}:close-proposal`, closureIteration);
  const closure = current<Json>(ctx, outputs.closure, `i${n}:closure`, closureIteration);
  const publicationChainValid = publicationCausalChainValid(finalPublication, n, issue.identitySha256, admittedPaths);
  const closeAuthorized =
    close?.decision === "close" &&
    closureRefresh?.ready === true &&
    publicationChainValid &&
    closureRefresh.sourcePublicationProofId === finalPublication?.proofId &&
    closureRefresh.proofId === closureRefreshProofIdentifier(closureRefresh) &&
    close.sourceClosureRefreshId === closureRefresh.proofId &&
    close.issueNumber === n &&
    close.headSha === closureRefresh.headSha &&
    close.diffSha256 === closureRefresh.diffSha256 &&
    close.patchId === closureRefresh.patchId &&
    close.approvalIteration === closureRefresh.approvalIteration &&
    close.closureAttempt === closureRefresh.closureAttempt &&
    JSON.stringify(close.changedPaths) === JSON.stringify(closureRefresh.changedPaths) &&
    JSON.stringify(close.envelope) === JSON.stringify(closureRefresh.envelope) &&
    close.operationMarker === closureRefresh.operationMarker &&
    isNonBlank(close.comment) &&
    close.comment.includes(closureRefresh.headSha);
  const closeApprovalBound = closeAuthorized && closure?.sourceCloseApprovalId === closeApprovalProof(close);
  const closureChainValid = closureCausalChainValid(
    finalPublication,
    closureRefresh,
    closure,
    closeApprovalBound,
    n,
    issue.identitySha256,
    admittedPaths,
  );
  const priorRebase =
    iteration > 0 ? current<Json>(ctx, outputs.rebaseProof, `i${n}:rebase`, iteration - 1) : undefined;
  const priorPublication =
    iteration > 0 ? current<Json>(ctx, outputs.publication, `i${n}:publication`, iteration - 1) : undefined;
  const priorPublicationProposal =
    iteration > 0
      ? current<Json>(ctx, outputs.lunaProposal, `i${n}:publication-luna-proposal`, iteration - 1)
      : undefined;
  const priorReview =
    iteration > 0 ? current<Json>(ctx, outputs.fableReview, `i${n}:landing-review`, iteration - 1) : undefined;
  const priorCheck =
    iteration > 0 ? current<Json>(ctx, outputs.evidenceCheck, `i${n}:landing-review-check`, iteration - 1) : undefined;
  const priorGates =
    iteration > 0 ? current<Json>(ctx, outputs.gates, `i${n}:landing-gates`, iteration - 1) : undefined;
  const priorLandingAttempt =
    iteration > 0
      ? current<Json>(ctx, outputs.candidateEvidence, `i${n}:landing-correction-evidence`, iteration - 1)
      : undefined;
  const priorLandingProtection =
    iteration > 0 ? current<Json>(ctx, outputs.protection, `i${n}:landing-protection`, iteration - 1) : undefined;
  const priorLandingProposal =
    iteration > 0 ? current<Json>(ctx, outputs.lunaProposal, `i${n}:landing-luna-proposal`, iteration - 1) : undefined;
  const priorLandingAmend =
    iteration > 0 ? current<Json>(ctx, outputs.commitProof, `i${n}:landing-amend`, iteration - 1) : undefined;
  const priorCorrectionFailed =
    !!priorLandingAttempt &&
    !(
      priorLandingAmend?.exactlyOneCommit === true &&
      priorLandingAmend.clean === true &&
      priorLandingAmend.messageValid === true &&
      priorLandingAmend.protectedPathClean === true &&
      priorLandingAmend.decision === "committed"
    );
  const needsLandingCorrection =
    iteration > 0 &&
    (priorCorrectionFailed ||
      priorRebase?.decision === "reject" ||
      priorRebase?.status === "conflict-aborted" ||
      priorReview?.approved === false ||
      priorCheck?.passed === false ||
      priorGates?.passed === false);
  const landingAttempt = current<Json>(ctx, outputs.candidateEvidence, `i${n}:landing-correction-evidence`, iteration);
  const landingSol = current<Json>(ctx, outputs.solImplement, `i${n}:landing-sol-implement`, iteration);
  const landingProtection = current<Json>(ctx, outputs.protection, `i${n}:landing-protection`, iteration);
  const landingProposal = current<Json>(ctx, outputs.lunaProposal, `i${n}:landing-luna-proposal`, iteration);
  const landingAmend = current<Json>(ctx, outputs.commitProof, `i${n}:landing-amend`, iteration);
  const correctionFeedback = [
    priorRebase?.summary,
    ...(priorReview?.findings ?? []),
    priorCheck?.summary,
    priorGates?.summary,
    priorLandingProtection?.passed === false
      ? `landing protection: ${priorLandingProtection.violations.join(", ") || priorLandingProtection.evidence}`
      : undefined,
    priorLandingProposal?.valid === false ? `landing Luna: ${priorLandingProposal.rationale}` : undefined,
    priorLandingAmend?.failure,
    ...(priorGates?.commands ?? [])
      .filter((command: Json) => !command.passed)
      .map(
        (command: Json) =>
          `gate ${JSON.stringify(command.argv)} exit=${command.exitCode} timeout=${command.timedOut}: ${command.log}`,
      ),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  const correctionCommitBound =
    correction?.sourceCommitProofId === correctionCommit?.proofId &&
    correctionCommit?.issueNumber === n &&
    correctionCommit?.issueIdentitySha256 === issue.identitySha256 &&
    correctionCommit?.approvalPhase === "candidate-commit" &&
    correctionCommit?.approvalIteration === correctionIteration &&
    correctionCommit?.sourceApprovalId === lunaApprovalProof(correctionProposal ?? {}) &&
    JSON.stringify(correctionCommit?.envelope) === JSON.stringify(admittedPaths) &&
    isNonBlank(correctionCommit?.proofId) &&
    correctionCommit.proofId === commitProofIdentifier(correctionCommit);
  const landingAmendBound =
    landingAmend?.issueNumber === n &&
    landingAmend?.issueIdentitySha256 === issue.identitySha256 &&
    landingAmend?.approvalPhase === "landing-amend" &&
    landingAmend?.approvalIteration === iteration &&
    landingAmend?.sourceApprovalId === lunaApprovalProof(landingProposal ?? {}) &&
    JSON.stringify(landingAmend?.envelope) === JSON.stringify(admittedPaths) &&
    isNonBlank(landingAmend?.proofId) &&
    landingAmend.proofId === commitProofIdentifier(landingAmend);
  const priorRebaseBound =
    priorRebase?.issueNumber === n &&
    priorRebase?.issueIdentitySha256 === issue.identitySha256 &&
    priorRebase?.approvalIteration === iteration - 1 &&
    orderedEqual(priorRebase?.envelope, admittedPaths) &&
    candidateProofIdValid(priorRebase) &&
    priorRebase?.exactlyOneCommit === true &&
    priorRebase?.clean === true &&
    priorRebase?.messageValid === true &&
    priorRebase?.protectedPathClean === true &&
    priorRebase?.exactChangedPaths === true;
  const priorPublicationValid =
    publicationCausalChainValid(priorPublication, n, issue.identitySha256, admittedPaths) &&
    priorPublication?.sourceRebaseProofId === priorRebase?.proofId;
  const retryFromPriorRebase = !needsLandingCorrection && priorRebaseBound && !priorPublicationValid;
  const sourceCommitProof = needsLandingCorrection
    ? landingAmend
    : retryFromPriorRebase
      ? priorRebase
      : correctionCommit;
  const sourceCommitProofBound = needsLandingCorrection
    ? landingAmendBound
    : retryFromPriorRebase
      ? priorRebaseBound
      : correctionCommitBound;
  const landingCorrectionPassed =
    sourceCommitProofBound &&
    sourceCommitProof?.exactlyOneCommit === true &&
    sourceCommitProof.clean === true &&
    sourceCommitProof.messageValid === true &&
    sourceCommitProof.protectedPathClean === true &&
    (sourceCommitProof.decision === "committed" || sourceCommitProof.decision === "review");
  const reachableRecoveryBound =
    live?.ready === true &&
    live?.decision === "implement" &&
    landingCorrectionPassed &&
    refresh?.issueNumber === n &&
    refresh?.decision === "already-reachable" &&
    refresh?.alreadyReachable === true &&
    refresh?.consistentReachability === true &&
    refresh?.collisionEvidenceOk === true &&
    refresh?.canonicalOrigin === true &&
    refresh?.fetchExitCode === 0 &&
    refresh?.issueOpen === true &&
    refresh?.identityMatches === true &&
    refresh?.issueIdentitySha256 === issue.identitySha256 &&
    refresh?.sourceCommitProofId === sourceCommitProof?.proofId &&
    candidateProofIdValid(sourceCommitProof) &&
    candidateProofParent(sourceCommitProof) === refresh?.oldBaseSha &&
    candidateProofHead(sourceCommitProof) === refresh?.headSha &&
    sourceCommitProof?.diffSha256 === refresh?.diffSha256 &&
    sourceCommitProof?.patchId === refresh?.patchId &&
    sourceCommitProof?.commitMessageSha256 === refresh?.commitMessageSha256 &&
    orderedEqual(sourceCommitProof?.changedPaths, refresh?.changedPaths) &&
    orderedEqual(sourceCommitProof?.envelope, admittedPaths) &&
    orderedEqual(refresh?.envelope, admittedPaths) &&
    pathsWithinEnvelope(refresh?.changedPaths ?? [], admittedPaths) &&
    priorPublicationProposal?.issueNumber === n &&
    priorPublicationProposal?.issueIdentitySha256 === issue.identitySha256 &&
    priorPublicationProposal?.approvalPhase === "publication" &&
    priorPublicationProposal?.sourceProofId === sourceCommitProof?.proofId &&
    priorPublicationProposal?.approvalIteration === sourceCommitProof?.approvalIteration &&
    priorPublicationProposal?.valid === true &&
    priorPublicationProposal?.decision === "propose" &&
    priorPublicationProposal?.stagePaths?.length === 0 &&
    orderedEqual(priorPublicationProposal?.changedPaths, refresh?.changedPaths) &&
    orderedEqual(priorPublicationProposal?.envelope, admittedPaths);
  return (
    <Sequence key={`landing-${n}`}>
      {bootstrap?.ready === false || live?.ready === false || correction?.ready === false ? (
        <Task id={`i${n}:terminal`} output={outputs.laneTerminal}>
          {() => {
            const source = correction?.ready === false ? correction : live?.ready === false ? live : bootstrap!;
            const evidence = [source.summary, ...(source.feedback ?? []), ...(source.evidence ?? [])].filter(
              (x): x is string => typeof x === "string" && x.length > 0,
            );
            return {
              issueNumber: n,
              result: "deferred" as const,
              reason: source.summary,
              evidence,
              headSha: source.headSha ?? source.currentOriginSha ?? source.baseSha ?? "",
              summary: source.summary,
            };
          }}
        </Task>
      ) : null}
      {correction?.ready === true ? (
        <Branch
          if
          then={
            <Loop id={loopId} maxIterations={retries} until={publicationChainValid} onMaxReached="return-last">
              <Sequence>
                {needsLandingCorrection ? (
                  <Sequence>
                    <Task id={`i${n}:landing-correction-evidence`} output={outputs.candidateEvidence}>
                      {() => {
                        const head = value(git(["rev-parse", "HEAD"], cwd));
                        return evidence(n, value(git(["rev-parse", `${head}^`], cwd)), cwd);
                      }}
                    </Task>
                    {landingAttempt && !landingAttempt.tooLarge ? (
                      <Branch
                        if
                        then={
                          <Task
                            id={`i${n}:landing-sol-implement`}
                            output={outputs.solImplement}
                            agent={codex("gpt-5.6-sol", "write", cwd)}
                            continueOnFail
                          >
                            <SolPrompt
                              issue={issue}
                              candidate={landingAttempt}
                              iteration={iteration}
                              attempt={correction.attempt + iteration + 1}
                              previousFeedback={correctionFeedback}
                            />
                          </Task>
                        }
                      />
                    ) : null}
                    {landingSol &&
                    landingAttempt &&
                    landingSol.issueNumber === n &&
                    landingSol.headSha === landingAttempt.headSha &&
                    landingSol.diffSha256 === landingAttempt.diffSha256 &&
                    landingSol.decision === "correct" ? (
                      <Branch
                        if
                        then={
                          <Task id={`i${n}:landing-protection`} output={outputs.protection}>
                            {() => {
                              const now = evidence(n, landingAttempt.baseSha, cwd);
                              const envelopeClean = pathsWithinEnvelope(now.changedPaths, admittedPaths);
                              const violations = [
                                ...protectedPaths(now.changedPaths),
                                ...(!envelopeClean
                                  ? now.changedPaths
                                      .filter((path: string) => !pathsWithinEnvelope([path], admittedPaths))
                                      .map((path: string) => `unexpected:${path}`)
                                  : []),
                              ];
                              return {
                                issueNumber: n,
                                headSha: now.headSha,
                                diffSha256: now.diffSha256,
                                passed: now.changedPaths.length > 0 && !now.tooLarge && violations.length === 0,
                                violations,
                                changedPaths: now.changedPaths,
                                stagePaths: now.stagePaths,
                                tooLarge: now.tooLarge,
                                decision: violations.length || now.tooLarge ? "reject" : "pass",
                                evidence: now.completePatch,
                              };
                            }}
                          </Task>
                        }
                      />
                    ) : null}
                    {landingProtection?.passed === true ? (
                      <Branch
                        if
                        then={
                          <Task
                            id={`i${n}:landing-luna-proposal`}
                            output={outputs.lunaProposal}
                            agent={codex("gpt-5.6-luna", "read", cwd)}
                            continueOnFail
                          >
                            <LunaCommitPrompt
                              issue={issue}
                              issueIdentitySha256={issue.identitySha256}
                              baseSha={landingAttempt?.baseSha}
                              candidate={evidence(n, landingAttempt!.baseSha, cwd)}
                              iteration={iteration}
                              envelope={admittedPaths}
                              approvalPhase="landing-amend"
                              sourceProofId={candidateEvidenceProof(
                                issue,
                                evidence(n, landingAttempt!.baseSha, cwd),
                                admittedPaths,
                                "landing-amend",
                                iteration,
                              )}
                            />
                          </Task>
                        }
                      />
                    ) : null}
                    {landingProposal?.valid === true &&
                    landingProposal.issueNumber === n &&
                    landingProposal.issueIdentitySha256 === issue.identitySha256 &&
                    landingProposal.headSha === landingProtection?.headSha &&
                    landingProposal.diffSha256 === landingProtection?.diffSha256 &&
                    landingProposal.approvalIteration === iteration &&
                    landingProposal.approvalPhase === "landing-amend" &&
                    landingProposal.decision === "propose" ? (
                      <Branch
                        if
                        then={
                          <Task id={`i${n}:landing-amend`} output={outputs.commitProof}>
                            {() =>
                              commitCandidate(
                                n,
                                issue.identitySha256,
                                landingAttempt!.baseSha,
                                cwd,
                                landingProposal,
                                "landing-amend",
                                iteration,
                                admittedPaths,
                              )
                            }
                          </Task>
                        }
                      />
                    ) : null}
                  </Sequence>
                ) : null}
                {landingCorrectionPassed ? (
                  <Branch
                    if
                    then={
                      <Task id={`i${n}:landing-refresh`} output={outputs.landingRefresh}>
                        {() => {
                          const head = value(git(["rev-parse", "HEAD"], cwd));
                          const oldBase = value(git(["rev-parse", `${head}^`], cwd));
                          const patch = evidence(n, oldBase, cwd);
                          const message = value(git(["log", "-1", "--format=%B", head], cwd));
                          let intrinsic: Json | undefined;
                          try {
                            intrinsic = exactCommitTuple(cwd, n, head);
                          } catch {
                            intrinsic = undefined;
                          }
                          const sourceBound =
                            sourceCommitProofBound &&
                            candidateProofIdValid(sourceCommitProof) &&
                            sourceCommitProof?.issueIdentitySha256 === issue.identitySha256 &&
                            candidateProofParent(sourceCommitProof) === oldBase &&
                            candidateProofHead(sourceCommitProof) === head &&
                            sourceCommitProof?.diffSha256 === patch.diffSha256 &&
                            sourceCommitProof?.patchId === patch.patchId &&
                            sourceCommitProof?.commitMessageSha256 === sha256(message) &&
                            orderedEqual(sourceCommitProof?.changedPaths, patch.changedPaths) &&
                            orderedEqual(sourceCommitProof?.envelope, admittedPaths) &&
                            intrinsicMatches(intrinsic, {
                              issueNumber: n,
                              parentSha: oldBase,
                              headSha: head,
                              diffSha256: patch.diffSha256,
                              patchId: patch.patchId,
                              changedPaths: patch.changedPaths,
                              commitMessageSha256: sha256(message),
                            });
                          const fetch = fetchCanonicalMain(cwd);
                          const url = origin(cwd);
                          const pushUrl = pushOrigin(cwd);
                          const canonical = canonicalOrigin(cwd);
                          const newBase = remoteSha(cwd);
                          const currentIssue = fetchIssue(n);
                          const fixes = fetch.ok ? matchingFixes(n, newBase, cwd) : ["QUERY-ERROR:fetch"];
                          const equivalents = fetch.ok
                            ? equivalentCommits(patch.patchId, newBase, patch.changedPaths, cwd)
                            : ["QUERY-ERROR:fetch"];
                          const reachable = fetch.ok && isNonBlank(head) && newBase === head;
                          const readyPeers = (ctx.outputs.laneReadiness ?? [])
                            .filter(
                              (row: Json) =>
                                row.ready === true &&
                                row.iteration === (ctx.iterations?.[`i${row.issueNumber}:correction-loop`] ?? 0),
                            )
                            .map((row: Json) => ({
                              issueNumber: row.issueNumber,
                              changedPaths: row.changedPaths ?? [],
                            }));
                          const peerOverlaps = peerPathOverlaps(n, patch.changedPaths, readyPeers);
                          const liveCollision = activeCollisionPaths(patch.changedPaths, cwd);
                          const identityMatches = currentIssue?.identitySha256 === issue.identitySha256;
                          const queryOk =
                            !fixes.some((x) => x.startsWith("QUERY-ERROR:")) &&
                            !equivalents.some((x) => x.startsWith("QUERY-ERROR:"));
                          const consistentReachability =
                            reachable && sourceBound && queryOk && (fixes.includes(head) || equivalents.includes(head));
                          const envelopeClean = pathsWithinEnvelope(patch.changedPaths, admittedPaths);
                          const ready =
                            sourceBound &&
                            fetch.ok &&
                            canonical &&
                            !!currentIssue &&
                            currentIssue.state === "open" &&
                            identityMatches &&
                            envelopeClean &&
                            peerOverlaps.length === 0 &&
                            liveCollision.ok &&
                            liveCollision.collisions.length === 0 &&
                            queryOk &&
                            fixes.length === 0 &&
                            equivalents.length === 0 &&
                            !reachable &&
                            value(git(["rev-list", "--count", `${oldBase}..${head}`], cwd)) === "1" &&
                            residueStatus(cwd) === "";
                          return {
                            issueNumber: n,
                            sourceCommitProofId: sourceBound ? sourceCommitProof!.proofId : "",
                            approvalIteration: iteration,
                            envelope: admittedPaths,
                            commitMessageSha256: sha256(message),
                            ready,
                            collisionEvidenceOk: liveCollision.ok && queryOk,
                            canonicalOrigin: canonical,
                            originUrl: url,
                            pushUrl,
                            fetchExitCode: fetch.exitCode,
                            issueOpen: currentIssue?.state === "open",
                            identityMatches,
                            issueIdentitySha256: currentIssue?.identitySha256 ?? "",
                            oldBaseSha: oldBase,
                            newBaseSha: newBase,
                            headSha: head,
                            diffSha256: patch.diffSha256,
                            statusSha256: patch.statusSha256,
                            patchId: patch.patchId,
                            changedPaths: patch.changedPaths,
                            matchingFixesCommits: fixes,
                            equivalentCommits: equivalents,
                            alreadyReachable: reachable,
                            consistentReachability,
                            decision: consistentReachability
                              ? ("already-reachable" as const)
                              : ready
                                ? ("rebase" as const)
                                : ("defer" as const),
                            evidence: [
                              `source commit proof bound ${sourceBound}`,
                              `fetch exit ${fetch.exitCode}`,
                              `canonical fetch+push ${canonical}`,
                              `identity ${currentIssue?.identitySha256 ?? "missing"}`,
                              `current parent ${oldBase}`,
                              `candidate digest ${patch.diffSha256}`,
                              `candidate paths ${patch.changedPaths.join(",")}`,
                              `admitted envelope ${envelopeClean}`,
                              `collision queries complete ${liveCollision.ok && queryOk}`,
                              `ready peer overlaps ${peerOverlaps.join(",") || "none"}`,
                              `live collisions ${liveCollision.collisions.join(",") || "none"}`,
                              `fixes ${fixes.join(",") || "none"}`,
                              `equivalents ${equivalents.join(",") || "none"}`,
                              `reachable+consistent ${consistentReachability}`,
                            ],
                            summary: ready
                              ? "Fresh landing evidence binds the exact causal commit proof and permits rebase."
                              : consistentReachability
                                ? "Fresh canonical evidence proves this exact candidate already reachable and equivalent."
                                : "Fresh landing evidence, causal proof, path envelope, peer overlap, residue, or collision query blocks publication.",
                          };
                        }}
                      </Task>
                    }
                  />
                ) : null}
                {reachableRecoveryBound ? (
                  <Task id={`i${n}:publication`} output={outputs.publication}>
                    {() =>
                      recoverPublication(
                        n,
                        issue,
                        cwd,
                        admittedPaths,
                        sourceCommitProof!,
                        priorPublicationProposal!,
                        refresh!,
                      )
                    }
                  </Task>
                ) : null}
                {refresh?.ready === true ? (
                  <Branch
                    if
                    then={
                      <Sequence>
                        <Task id={`i${n}:rebase`} output={outputs.rebaseProof}>
                          {() => {
                            const preflight = evidence(n, refresh.oldBaseSha, cwd);
                            const beforeHead = preflight.headSha;
                            const beforeStatus = status(cwd);
                            let sourceIntrinsic: Json | undefined;
                            try {
                              sourceIntrinsic = exactCommitTuple(cwd, n, refresh.headSha);
                            } catch {
                              sourceIntrinsic = undefined;
                            }
                            const common = {
                              issueNumber: n,
                              issueIdentitySha256: issue.identitySha256,
                              sourceCommitProofId: refresh.sourceCommitProofId,
                              proofId: "",
                              approvalIteration: refresh.approvalIteration,
                              envelope: admittedPaths,
                              oldBaseSha: refresh.oldBaseSha,
                              newBaseSha: refresh.newBaseSha,
                              sourceCommitSha: refresh.headSha,
                              headSha: beforeHead,
                              diffSha256: refresh.diffSha256,
                              patchId: refresh.patchId,
                              commitMessageSha256: refresh.commitMessageSha256,
                              status: "failed" as "unchanged" | "rebased" | "conflict-aborted" | "failed",
                              exactlyOneCommit: false,
                              messageValid: false,
                              protectedPathClean: false,
                              clean: beforeStatus === "",
                              abortRestored: true,
                              exactChangedPaths: false,
                              changedPaths: preflight.changedPaths,
                              decision: "reject" as "review" | "retry" | "reject",
                              summary: "Candidate changed after landing refresh; no rebase ran.",
                            };
                            const exactInput =
                              sourceCommitProofBound &&
                              !!sourceCommitProof &&
                              refresh.approvalIteration === iteration &&
                              sourceCommitProof.proofId === refresh.sourceCommitProofId &&
                              candidateProofIdValid(sourceCommitProof) &&
                              sourceCommitProof.issueIdentitySha256 === issue.identitySha256 &&
                              candidateProofHead(sourceCommitProof) === refresh.headSha &&
                              candidateProofParent(sourceCommitProof) === refresh.oldBaseSha &&
                              sourceCommitProof.diffSha256 === refresh.diffSha256 &&
                              sourceCommitProof.patchId === refresh.patchId &&
                              sourceCommitProof.commitMessageSha256 === refresh.commitMessageSha256 &&
                              orderedEqual(sourceCommitProof.changedPaths, refresh.changedPaths) &&
                              orderedEqual(sourceCommitProof.envelope, admittedPaths) &&
                              intrinsicMatches(sourceIntrinsic, {
                                issueNumber: n,
                                parentSha: refresh.oldBaseSha,
                                headSha: refresh.headSha,
                                diffSha256: refresh.diffSha256,
                                patchId: refresh.patchId,
                                changedPaths: refresh.changedPaths,
                                commitMessageSha256: refresh.commitMessageSha256,
                              }) &&
                              beforeHead === refresh.headSha &&
                              preflight.diffSha256 === refresh.diffSha256 &&
                              preflight.patchId === refresh.patchId &&
                              preflight.statusSha256 === refresh.statusSha256 &&
                              orderedEqual(preflight.changedPaths, refresh.changedPaths) &&
                              beforeStatus === "";
                            if (!exactInput) return common;
                            const result =
                              refresh.oldBaseSha === refresh.newBaseSha
                                ? { ok: true }
                                : git(
                                    [
                                      "-c",
                                      "core.hooksPath=/dev/null",
                                      "-c",
                                      "commit.gpgSign=false",
                                      "rebase",
                                      "--onto",
                                      refresh.newBaseSha,
                                      refresh.oldBaseSha,
                                      refresh.headSha,
                                    ],
                                    cwd,
                                  );
                            if (!result.ok) {
                              const restored = cleanLaneResidue(cwd, refresh.headSha);
                              const restoredEvidence = evidence(n, refresh.oldBaseSha, cwd);
                              const exactRestored =
                                restored &&
                                restoredEvidence.headSha === refresh.headSha &&
                                restoredEvidence.diffSha256 === refresh.diffSha256 &&
                                restoredEvidence.statusSha256 === refresh.statusSha256 &&
                                residueStatus(cwd) === "";
                              return {
                                ...common,
                                headSha: value(git(["rev-parse", "HEAD"], cwd)),
                                status: "conflict-aborted" as const,
                                clean: residueStatus(cwd) === "",
                                abortRestored: exactRestored,
                                decision: "retry" as const,
                                summary: exactRestored
                                  ? "Rebase conflicted; abort/reset/ignored cleanup restored the exact clean causal candidate."
                                  : "Rebase conflicted and exact residue-free restoration could not be proved.",
                              };
                            }
                            const head = value(git(["rev-parse", "HEAD"], cwd));
                            const residueClean = cleanLaneResidue(cwd, head);
                            const landing = evidence(n, refresh.newBaseSha, cwd);
                            let tuple: Json | undefined;
                            try {
                              tuple = exactCommitTuple(cwd, n, head);
                            } catch {
                              tuple = undefined;
                            }
                            const one =
                              value(git(["rev-list", "--count", `${refresh.newBaseSha}..${head}`], cwd)) === "1";
                            const clean = residueClean && residueStatus(cwd) === "";
                            const protectedClean =
                              protectedPaths(tuple?.changedPaths ?? landing.changedPaths).length === 0;
                            const messageValid = tuple?.commitMessageSha256 === refresh.commitMessageSha256;
                            const exactPaths = orderedEqual(tuple?.changedPaths, refresh.changedPaths);
                            const proven =
                              one &&
                              clean &&
                              protectedClean &&
                              messageValid &&
                              exactPaths &&
                              tuple?.parentSha === refresh.newBaseSha &&
                              tuple?.patchId === refresh.patchId &&
                              tuple?.diffSha256 === landing.diffSha256 &&
                              tuple?.headSha === landing.headSha &&
                              landing.clean &&
                              landing.changedPaths.length > 0;
                            if (!proven) {
                              const restored = cleanLaneResidue(cwd, refresh.headSha);
                              return {
                                ...common,
                                headSha: value(git(["rev-parse", "HEAD"], cwd)),
                                diffSha256: tuple?.diffSha256 ?? landing.diffSha256,
                                patchId: tuple?.patchId ?? landing.patchId,
                                messageValid,
                                protectedPathClean: protectedClean,
                                clean: residueStatus(cwd) === "",
                                abortRestored: restored,
                                exactChangedPaths: exactPaths,
                                changedPaths: tuple?.changedPaths ?? landing.changedPaths,
                                summary: restored
                                  ? "Post-rebase stable-patch/path/message/parent proof failed and the prior causal candidate was restored."
                                  : "Post-rebase proof failed and restoration was not proved.",
                              };
                            }
                            const proof = {
                              ...common,
                              headSha: head,
                              diffSha256: tuple!.diffSha256,
                              patchId: tuple!.patchId,
                              status:
                                refresh.oldBaseSha === refresh.newBaseSha
                                  ? ("unchanged" as const)
                                  : ("rebased" as const),
                              exactlyOneCommit: true,
                              messageValid: true,
                              protectedPathClean: true,
                              clean: true,
                              abortRestored: true,
                              exactChangedPaths: true,
                              changedPaths: tuple!.changedPaths,
                              decision: "review" as const,
                              summary:
                                "Post-rebase proof binds the source commit proof to one clean commit with preserved stable patch, message, paths, identity, and envelope.",
                            };
                            return { ...proof, proofId: rebaseProofIdentifier(proof) };
                          }}
                        </Task>
                        {rebase &&
                        rebase.proofId === rebaseProofIdentifier(rebase) &&
                        rebase.sourceCommitProofId === refresh.sourceCommitProofId &&
                        rebase.exactlyOneCommit &&
                        rebase.messageValid &&
                        rebase.protectedPathClean &&
                        rebase.clean &&
                        rebase.exactChangedPaths ? (
                          <Branch
                            if
                            then={
                              <Sequence>
                                <Task id={`i${n}:landing-evidence`} output={outputs.candidateEvidence}>
                                  {() => evidence(n, rebase.newBaseSha, cwd)}
                                </Task>
                                {before && !before.tooLarge ? (
                                  <Branch
                                    if
                                    then={
                                      <Sequence>
                                        <Task
                                          id={`i${n}:landing-review`}
                                          output={outputs.fableReview}
                                          agent={fable(cwd)}
                                          continueOnFail
                                        >
                                          <FablePrompt issue={issue} candidate={before} phase="post-rebase landing" />
                                        </Task>
                                        <Task id={`i${n}:landing-review-check`} output={outputs.evidenceCheck}>
                                          {() => {
                                            const now = evidence(n, rebase.newBaseSha, cwd);
                                            const reviewBound =
                                              review?.issueNumber === n &&
                                              review?.decision === "approve" &&
                                              review?.approved === true &&
                                              review.headSha === before.headSha &&
                                              review.diffSha256 === before.diffSha256 &&
                                              isNonBlank(review.summary) &&
                                              nonBlankStrings(review.acceptanceEvidence);
                                            const passed =
                                              reviewBound &&
                                              now.headSha === before.headSha &&
                                              now.diffSha256 === before.diffSha256 &&
                                              now.statusSha256 === before.statusSha256 &&
                                              now.clean &&
                                              pathsWithinEnvelope(now.changedPaths, admittedPaths) &&
                                              protectedPaths(now.changedPaths).length === 0;
                                            return {
                                              issueNumber: n,
                                              headSha: now.headSha,
                                              diffSha256: now.diffSha256,
                                              passed,
                                              protectedPathClean: protectedPaths(now.changedPaths).length === 0,
                                              clean: now.clean,
                                              decision: passed ? "bound" : "reject",
                                              summary:
                                                "Exact issue/decision/head/digest/status post-rebase Fable binding with trimmed nonblank evidence re-proved mechanically.",
                                            };
                                          }}
                                        </Task>
                                        {check?.passed === true ? (
                                          <Branch
                                            if
                                            then={
                                              <Task id={`i${n}:landing-gates`} output={outputs.gates}>
                                                {() =>
                                                  runGates(
                                                    n,
                                                    rebase.newBaseSha,
                                                    before.headSha,
                                                    cwd,
                                                    before.changedPaths,
                                                  )
                                                }
                                              </Task>
                                            }
                                          />
                                        ) : null}
                                        {gates?.passed === true &&
                                        gates.headSha === before.headSha &&
                                        gates.diffSha256 === before.diffSha256 &&
                                        rebase.proofId === rebaseProofIdentifier(rebase) &&
                                        rebase.headSha === before.headSha &&
                                        rebase.diffSha256 === before.diffSha256 &&
                                        rebase.patchId === before.patchId &&
                                        orderedEqual(rebase.changedPaths, before.changedPaths) ? (
                                          <Branch
                                            if
                                            then={
                                              <Task
                                                id={`i${n}:publication-luna-proposal`}
                                                output={outputs.lunaProposal}
                                                agent={codex("gpt-5.6-luna", "read", cwd)}
                                                continueOnFail
                                              >
                                                <LunaCommitPrompt
                                                  issue={issue}
                                                  issueIdentitySha256={issue.identitySha256}
                                                  baseSha={rebase.newBaseSha}
                                                  candidate={before}
                                                  iteration={iteration}
                                                  envelope={admittedPaths}
                                                  approvalPhase="publication"
                                                  sourceProofId={rebase.proofId}
                                                  existingCommitMessage={value(
                                                    git(["log", "-1", "--format=%B", before.headSha], cwd),
                                                  )}
                                                  landingOnly
                                                />
                                              </Task>
                                            }
                                          />
                                        ) : null}
                                        {publicationProposal?.valid === true &&
                                        publicationProposal.decision === "propose" &&
                                        publicationProposal.issueNumber === n &&
                                        publicationProposal.issueIdentitySha256 === issue.identitySha256 &&
                                        publicationProposal.baseSha === rebase.newBaseSha &&
                                        publicationProposal.headSha === before.headSha &&
                                        publicationProposal.diffSha256 === before.diffSha256 &&
                                        publicationProposal.patchId === before.patchId &&
                                        publicationProposal.approvalPhase === "publication" &&
                                        publicationProposal.sourceProofId === rebase.proofId &&
                                        publicationProposal.approvalIteration === iteration &&
                                        Array.isArray(publicationProposal.stagePaths) &&
                                        publicationProposal.stagePaths.length === 0 &&
                                        orderedEqual(publicationProposal.changedPaths, before.changedPaths) &&
                                        orderedEqual(publicationProposal.envelope, admittedPaths) &&
                                        gates?.passed === true ? (
                                          <Branch
                                            if
                                            then={
                                              <Task id={`i${n}:publication`} output={outputs.publication}>
                                                {() =>
                                                  publishCandidate(
                                                    n,
                                                    issue,
                                                    cwd,
                                                    admittedPaths,
                                                    iteration,
                                                    rebase,
                                                    before,
                                                    publicationProposal,
                                                  )
                                                }
                                              </Task>
                                            }
                                          />
                                        ) : null}
                                      </Sequence>
                                    }
                                  />
                                ) : null}
                              </Sequence>
                            }
                          />
                        ) : null}
                      </Sequence>
                    }
                  />
                ) : null}
              </Sequence>
            </Loop>
          }
        />
      ) : null}
      {publicationChainValid ? (
        <Branch
          if
          then={
            <Loop id={closureLoopId} maxIterations={retries} until={closureChainValid} onMaxReached="return-last">
              <Sequence>
                <Task id={`i${n}:closure-refresh`} output={outputs.closureRefresh}>
                  {() => refreshClosure(n, issue, cwd, admittedPaths, finalPublication!, closureIteration + 1)}
                </Task>
                {closureRefresh?.ready === true &&
                closureRefresh.sourcePublicationProofId === finalPublication?.proofId &&
                closureRefresh.proofId === closureRefreshProofIdentifier(closureRefresh) &&
                closureRefresh.issueState === "closed" ? (
                  <Task id={`i${n}:closure`} output={outputs.closure}>
                    {() => alreadyClosedClosure(n, issue, cwd, admittedPaths, finalPublication!, closureRefresh)}
                  </Task>
                ) : null}
                {closureRefresh?.ready === true &&
                closureRefresh.sourcePublicationProofId === finalPublication?.proofId &&
                closureRefresh.proofId === closureRefreshProofIdentifier(closureRefresh) &&
                closureRefresh.issueState === "open" ? (
                  <Branch
                    if
                    then={
                      <Task
                        id={`i${n}:close-proposal`}
                        output={outputs.closeProposal}
                        agent={[
                          codex("gpt-5.6-luna", "read", cwd),
                          failClosedClosureAgent(
                            n,
                            closureRefresh.headSha,
                            closureRefresh.operationMarker,
                            closureRefresh.patchId,
                            closureRefresh.changedPaths,
                            closureRefresh.approvalIteration,
                            closureRefresh.envelope,
                            closureRefresh.closureAttempt,
                            closureRefresh.proofId,
                          ),
                        ]}
                        continueOnFail
                      >
                        <ClosePrompt
                          repo={CANONICAL_REPOSITORY}
                          issueNumber={n}
                          landedSha={closureRefresh.headSha}
                          currentState={JSON.stringify({
                            state: closureRefresh.issueState,
                            markerPresent: closureRefresh.markerPresent,
                            sourceClosureRefreshId: closureRefresh.proofId,
                            diffSha256: closureRefresh.diffSha256,
                            patchId: closureRefresh.patchId,
                            changedPaths: closureRefresh.changedPaths,
                            approvalIteration: closureRefresh.approvalIteration,
                            envelope: closureRefresh.envelope,
                            closureAttempt: closureRefresh.closureAttempt,
                          })}
                          sourceClosureRefreshId={closureRefresh.proofId}
                          operationMarker={closureRefresh.operationMarker}
                        />
                      </Task>
                    }
                  />
                ) : null}
                {closureRefresh?.issueState === "open" && closeAuthorized ? (
                  <Branch
                    if
                    then={
                      <Task id={`i${n}:closure`} output={outputs.closure}>
                        {() => executeClosure(n, issue, cwd, admittedPaths, finalPublication!, closureRefresh!, close!)}
                      </Task>
                    }
                  />
                ) : null}
              </Sequence>
            </Loop>
          }
        />
      ) : null}
      {closureChainValid ||
      (closureIteration + 1 >= retries && publicationChainValid) ||
      (!publicationChainValid && iteration + 1 >= retries && (landingAttempt || refresh || rebase || gates)) ? (
        <Task id={`i${n}:terminal`} output={outputs.laneTerminal}>
          {() => {
            const pub = current<Json>(ctx, outputs.publication, `i${n}:publication`, iteration);
            const done = current<Json>(ctx, outputs.closure, `i${n}:closure`, closureIteration);
            const landedClosed = closureChainValid;
            const evidenceRows = [
              ...correctionFeedback,
              landingAttempt?.summary,
              landingProtection?.evidence,
              landingProposal?.rationale,
              landingAmend?.failure,
              refresh?.summary,
              rebase?.summary,
              before?.summary,
              review?.summary,
              check?.summary,
              gates?.summary,
              pub?.summary,
              closureRefresh?.summary,
              close?.rationale,
              done?.summary,
              !close
                ? `Luna closure output absent at closure attempt ${closureIteration + 1}`
                : !closeAuthorized
                  ? `Luna closure bindings invalid at closure attempt ${closureIteration + 1}`
                  : undefined,
              closeAuthorized && !done ? `closure executor missing at attempt ${closureIteration + 1}` : undefined,
            ].filter(isNonBlank);
            const blocked = publicationChainValid && !closureChainValid;
            const reason = landedClosed
              ? "fresh exact-tip evidence proves the exact SHA is remote main and immutable issue closure is verified"
              : (done?.summary ??
                close?.rationale ??
                (!close
                  ? "Luna closure output was absent"
                  : !closeAuthorized
                    ? "Luna closure authorization was invalid"
                    : closeAuthorized && !done
                      ? "closure execution produced no verified output"
                      : undefined) ??
                closureRefresh?.summary ??
                pub?.summary ??
                landingAmend?.failure ??
                rebase?.summary ??
                refresh?.summary ??
                `landing iteration ${iteration} exhausted with recorded correction/gate evidence`);
            return {
              issueNumber: n,
              result: landedClosed
                ? ("landed+closed" as const)
                : blocked
                  ? ("blocked" as const)
                  : ("deferred" as const),
              reason,
              evidence: evidenceRows.length ? evidenceRows : [reason],
              headSha: pub?.commitSha ?? rebase?.headSha ?? landingAmend?.headSha ?? correction?.headSha ?? "",
              summary: reason,
            };
          }}
        </Task>
      ) : null}
    </Sequence>
  );
}

export default smithers((ctx: any) => {
  const raw = (ctx.input ?? {}) as Json;
  const boundedInt = (rawValue: unknown, fallback: number, max: number) => {
    if (rawValue == null) return fallback;
    const parsed = Number(rawValue);
    return Number.isInteger(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
  };
  const input = {
    repo: CANONICAL_REPOSITORY,
    excludeNumbers: explicitPathspec((Array.isArray(raw.excludeNumbers) ? raw.excludeNumbers : []).map(String))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
    laneConcurrency: boundedInt(raw.laneConcurrency, MAX_LANES, MAX_LANES),
    reviewIterations: boundedInt(raw.reviewIterations, 3, 4),
    landingRetries: boundedInt(raw.landingRetries, 3, 5),
    dryRun: raw.dryRun === true,
    conservativeLabelHints: Array.isArray(raw.conservativeLabelHints)
      ? raw.conservativeLabelHints.filter((x): x is string => typeof x === "string")
      : [],
    prompt:
      typeof raw.prompt === "string" && raw.prompt
        ? raw.prompt
        : "Admit only independently evidenced, localized, riskless work.",
  };
  const normalized = fixed<Json>(ctx, outputs.normalizeInputs, "normalize-inputs");
  const checkout = fixed<Json>(ctx, outputs.verifyCheckout, "verify-checkout");
  const sync = fixed<Json>(ctx, outputs.synchronizeMain, "synchronize-main");
  const discovery = fixed<Json>(ctx, outputs.discoverIssues, "discover-issues");
  const ledger = fixed<Json>(ctx, outputs.admissionLedger, "admission-ledger");
  const classificationRoot = input.dryRun
    ? root
    : join(root, ".smithers", "worktrees", "riskless-github-issue-sweep", String(ctx.runId), "classification");
  const syncReady = input.dryRun ? checkout?.safeToProceed === true : sync?.safeToProceed === true;
  const selected: number[] = ledger?.valid ? ledger.admittedIssueNumbers : [];
  const issueFor = (n: number): Json => {
    const issue = discovery?.issues.find((x: Json) => x.number === n);
    if (!issue) throw new Error(`admitted issue #${n} is absent from discovery evidence`);
    return issue;
  };
  const cwdFor = (n: number) =>
    join(root, ".smithers", "worktrees", "riskless-github-issue-sweep", String(ctx.runId), String(n));
  const terminal = selected.map((n) => fixed<Json>(ctx, outputs.laneTerminal, `i${n}:terminal`));
  const lanesComplete = terminal.length === selected.length && terminal.every(Boolean);
  const rescan = fixed<Json>(ctx, outputs.finalRescan, "final-rescan");
  const finalSync = fixed<Json>(ctx, outputs.finalSync, "final-sync");
  return (
    <Workflow name="riskless-github-issue-sweep">
      <UI entry="../ui/riskless-github-issue-sweep.tsx" title="Riskless GitHub Issue Sweep" />
      <Sequence>
        <Task id="normalize-inputs" output={outputs.normalizeInputs}>
          {() => ({
            valid: raw.repo == null || raw.repo === CANONICAL_REPOSITORY,
            ...input,
            protectedPaths: [...PROTECTED_PATH_HINTS],
            summary: "Runtime-null defaults normalized; canonical repository and 16-lane ceiling pinned.",
          })}
        </Task>
        {normalized?.valid === true && input.dryRun ? (
          <Branch
            if
            then={
              <Task id="verify-checkout" output={outputs.verifyCheckout}>
                {() => {
                  const url = origin();
                  const pushUrl = pushOrigin();
                  const canonical = canonicalOrigin();
                  const gitStatus = status(root);
                  const jjDiff = run(["jj", "diff", "--summary"], root);
                  const head = value(git(["rev-parse", "HEAD"], root));
                  const localMain = value(git(["rev-parse", "refs/heads/main"], root));
                  const trackingMain = value(git(["rev-parse", "refs/remotes/origin/main"], root));
                  const boundary = lsRemoteMain(root);
                  const query = boundary.result;
                  const remoteMain = boundary.sha;
                  const onMain = value(git(["branch", "--show-current"], root)) === "main" && head === localMain;
                  const clean = gitStatus === "" && jjDiff.ok && jjDiff.stdout.trim() === "";
                  const current = query.ok && dryRunMainIsCurrent(remoteMain, localMain, trackingMain, head);
                  return {
                    safeToProceed: canonical && clean && onMain && current,
                    canonicalOrigin: canonical,
                    originUrl: url,
                    pushUrl,
                    lsRemoteExitCode: query.exitCode,
                    remoteMainSha: remoteMain,
                    trackingMainSha: trackingMain,
                    localMainSha: localMain,
                    headSha: head,
                    clean,
                    onMain,
                    summary: current
                      ? "Read-only ls-remote proved canonical remote main exactly equals clean local main, HEAD, and the tracking ref."
                      : "Dry-run blocked because canonical remote main could not be queried or differs from local/tracking main.",
                  };
                }}
              </Task>
            }
          />
        ) : null}
        {normalized?.valid === true && !input.dryRun ? (
          <Branch
            if
            then={
              <Task id="synchronize-main" output={outputs.synchronizeMain}>
                {() => {
                  const url = origin();
                  const pushUrl = pushOrigin();
                  const canonical = canonicalOrigin();
                  const jjDiff = run(["jj", "diff", "--summary"], root);
                  const jjBasedOnMain = run(["jj", "log", "-r", "main::@", "--no-graph", "-T", "commit_id"], root);
                  const clean = status(root) === "" && jjDiff.ok && jjDiff.stdout.trim() === "";
                  const onMain =
                    value(git(["branch", "--show-current"])) === "main" &&
                    jjBasedOnMain.ok &&
                    jjBasedOnMain.stdout.trim().length > 0;
                  const fetch =
                    canonical && clean && onMain
                      ? fetchCanonicalMain(root)
                      : denied(["git", "fetch"], "checkout or canonical remote precondition failed");
                  const remote = remoteSha();
                  return {
                    safeToProceed: canonical && clean && onMain && fetch.ok && isNonBlank(remote),
                    canonicalOrigin: canonical,
                    originUrl: url,
                    pushUrl,
                    fetchExitCode: fetch.exitCode,
                    localMainSha: value(git(["rev-parse", "refs/heads/main"])),
                    remoteMainSha: remote,
                    classificationRoot,
                    clean,
                    onMain,
                    summary:
                      "Exactly one canonical HTTPS fetch URL and push URL plus git+jj clean/on-main evidence were verified before stable issue enumeration.",
                  };
                }}
              </Task>
            }
          />
        ) : null}
        {syncReady ? (
          <Branch
            if
            then={
              <Task id="discover-issues" output={outputs.discoverIssues}>
                {() => {
                  const queryMain = () => {
                    const boundary = input.dryRun ? lsRemoteMain(root) : { result: fetchCanonicalMain(root), sha: "" };
                    return { ok: boundary.result.ok, sha: input.dryRun ? boundary.sha : remoteSha(root) };
                  };
                  const pre = queryMain();
                  const found = discoverOpenIssues();
                  const post = queryMain();
                  const baseSha = pre.sha || "missing";
                  const stable = pre.ok && post.ok && isNonBlank(pre.sha) && pre.sha === post.sha;
                  const snapshot = stable
                    ? input.dryRun
                      ? { ok: value(git(["rev-parse", "HEAD"], root)) === pre.sha }
                      : ensureDetachedWorktree(classificationRoot, pre.sha)
                    : { ok: false };
                  const classificationHeadSha = snapshot.ok
                    ? value(git(["rev-parse", "HEAD"], classificationRoot))
                    : "missing";
                  const classificationSnapshotReady = snapshot.ok && classificationHeadSha === pre.sha;
                  const index = found.issues.map(({ number, title, labels, assignees, milestone, identitySha256 }) => ({
                    number,
                    title,
                    labels,
                    assignees,
                    milestone,
                    identitySha256,
                  }));
                  return {
                    repo: CANONICAL_REPOSITORY,
                    baseSha,
                    preEnumerationSha: pre.sha || "missing",
                    postEnumerationSha: post.sha || "missing",
                    classificationHeadSha,
                    classificationSnapshotReady,
                    enumerationBaseStable: stable,
                    issues: found.issues,
                    globalIndex: index,
                    completeMachineJson: found.rawJson,
                    discoveredCount: found.issues.length,
                    discoverySha256: sha256(found.rawJson),
                    summary:
                      stable && classificationSnapshotReady
                        ? "Remote main was stable across complete issue enumeration and the exact enumerated SHA is checked out for classification."
                        : "Remote main moved, a boundary query failed, or the classification checkout does not equal the enumerated base; admission will fail closed.",
                  };
                }}
              </Task>
            }
          />
        ) : null}
        {discovery?.issues.length && discovery.classificationSnapshotReady === true && syncReady ? (
          <Parallel id="classification-pass" subtreeConcurrency={Math.min(MAX_LANES, input.laneConcurrency)}>
            {discovery.issues.map((issue: Json) => (
              <Task
                key={issue.number}
                id={`i${issue.number}:classify`}
                output={outputs.classify}
                agent={codex("gpt-5.6-sol", "read", classificationRoot)}
                continueOnFail
              >
                <ClassifyPrompt
                  issue={issue}
                  baseSha={discovery.baseSha}
                  globalIndex={discovery.globalIndex}
                  excluded={input.excludeNumbers.includes(issue.number)}
                  protectedPaths={PROTECTED_PATH_HINTS}
                  labelHints={input.conservativeLabelHints}
                />
              </Task>
            ))}
          </Parallel>
        ) : null}
        {discovery?.issues.length && discovery.classificationSnapshotReady === true && syncReady ? (
          <Parallel id="adjudication-pass" subtreeConcurrency={Math.min(MAX_LANES, input.laneConcurrency)}>
            {discovery.issues.map((issue: Json) => {
              const classification = fixed<Json>(ctx, outputs.classify, `i${issue.number}:classify`);
              return classification ? (
                <Task
                  key={issue.number}
                  id={`i${issue.number}:adjudicate`}
                  output={outputs.adjudicate}
                  agent={codex("gpt-5.6-luna", "read", classificationRoot)}
                  continueOnFail
                >
                  <AdjudicatePrompt
                    issue={issue}
                    classification={classification}
                    baseSha={discovery.baseSha}
                    globalIndex={discovery.globalIndex}
                    excluded={input.excludeNumbers.includes(issue.number)}
                  />
                </Task>
              ) : null;
            })}
          </Parallel>
        ) : null}
        {discovery ? (
          <Task id="admission-ledger" output={outputs.admissionLedger}>
            {() => {
              const dispositions = discovery.issues.map((issue: Json) => {
                const c = fixed<Json>(ctx, outputs.classify, `i${issue.number}:classify`);
                const a = fixed<Json>(ctx, outputs.adjudicate, `i${issue.number}:adjudicate`);
                const excluded = input.excludeNumbers.includes(issue.number);
                const classifierCurrent =
                  c?.issueNumber === issue.number &&
                  c?.issueIdentitySha256 === issue.identitySha256 &&
                  c?.headSha === discovery.baseSha &&
                  c?.diffSha256 === issue.identitySha256 &&
                  c?.decision === c?.disposition &&
                  nonBlankStrings(c?.evidence) &&
                  nonBlankStrings(c?.acceptanceCriteria) &&
                  isNonBlank(c?.rationale) &&
                  (c?.disposition !== "admit" || nonBlankStrings(c?.likelyPaths));
                const adjudicatorCurrent =
                  a?.issueNumber === issue.number &&
                  a?.issueIdentitySha256 === issue.identitySha256 &&
                  a?.headSha === discovery.baseSha &&
                  a?.diffSha256 === issue.identitySha256 &&
                  a?.decision === a?.disposition &&
                  nonBlankStrings(a?.evidence) &&
                  nonBlankStrings(a?.acceptanceCriteria) &&
                  isNonBlank(a?.rationale) &&
                  (a?.disposition !== "admit" || nonBlankStrings(a?.likelyPaths));
                const missingRoles = [
                  ...(!classifierCurrent ? ["classifier" as const] : []),
                  ...(!adjudicatorCurrent ? ["adjudicator" as const] : []),
                ];
                const classifierEnvelope = canonicalAdmissionEnvelope(c?.likelyPaths ?? []);
                const adjudicatorEnvelope = canonicalAdmissionEnvelope(a?.likelyPaths ?? []);
                const independentAgreement =
                  classifierEnvelope !== null &&
                  adjudicatorEnvelope !== null &&
                  JSON.stringify(classifierEnvelope) === JSON.stringify(adjudicatorEnvelope);
                const paths = independentAgreement ? classifierEnvelope! : [];
                const admit =
                  !excluded &&
                  independentAgreement &&
                  paths.length > 0 &&
                  classifierCurrent &&
                  adjudicatorCurrent &&
                  c?.disposition === "admit" &&
                  c.eligible === true &&
                  a?.disposition === "admit" &&
                  a.approved === true &&
                  c.riskFlags.length === 0 &&
                  a.riskFlags.length === 0 &&
                  c.overlapIssueNumbers.length === 0 &&
                  a.overlapIssueNumbers.length === 0;
                const evidence = excluded
                  ? [
                      `input excludeNumbers contains #${issue.number}`,
                      `discovery immutable identity ${issue.identitySha256}`,
                      ...(c?.evidence ?? []),
                      ...(a?.evidence ?? []),
                    ]
                  : missingRoles.length
                    ? [
                        `mechanically missing or stale required rows: ${missingRoles.join(", ")}`,
                        `discovery immutable identity ${issue.identitySha256}`,
                      ]
                    : [...(c?.evidence ?? []), ...(a?.evidence ?? [])];
                return {
                  issueNumber: issue.number,
                  disposition: admit ? ("admitted" as const) : ("deferred" as const),
                  reason: admit
                    ? "two independently bound current rows support localized riskless work"
                    : excluded
                      ? "explicitly excluded with both role rows required for coverage"
                      : missingRoles.length
                        ? "required role coverage is incomplete"
                        : "risk, ambiguity, overlap, protection, or insufficient independent evidence",
                  evidence,
                  missingRoles,
                  likelyPaths: paths,
                  issueIdentitySha256: issue.identitySha256,
                };
              });
              const coverage =
                dispositions.length === discovery.issues.length &&
                dispositions.every((d: Json) => d.missingRoles.length === 0);
              const syncProven = input.dryRun ? checkout?.safeToProceed === true : sync?.safeToProceed === true;
              return {
                valid:
                  coverage &&
                  syncProven &&
                  discovery.enumerationBaseStable === true &&
                  discovery.classificationSnapshotReady === true &&
                  discovery.classificationHeadSha === discovery.baseSha &&
                  discovery.issues.length > 0,
                coverageComplete: coverage,
                syncProven,
                discoveredCount: discovery.issues.length,
                consideredCount: dispositions.length,
                admittedIssueNumbers:
                  coverage &&
                  discovery.enumerationBaseStable === true &&
                  discovery.classificationSnapshotReady === true &&
                  discovery.classificationHeadSha === discovery.baseSha
                    ? dispositions.filter((d: Json) => d.disposition === "admitted").map((d: Json) => d.issueNumber)
                    : [],
                dispositions,
                summary:
                  coverage &&
                  discovery.enumerationBaseStable === true &&
                  discovery.classificationSnapshotReady === true &&
                  discovery.classificationHeadSha === discovery.baseSha
                    ? "Every discovered issue has correctly bound current rows produced from the exact stable classification checkout."
                    : "Coverage is invalid because a required current role row is absent/stale, remote main moved, or the classification checkout differs from the enumerated base.",
              };
            }}
          </Task>
        ) : null}
        {!input.dryRun &&
        normalized?.valid &&
        ledger?.valid &&
        ledger.coverageComplete &&
        ledger.syncProven &&
        selected.length ? (
          <Parallel id="issue-lanes" subtreeConcurrency={Math.min(MAX_LANES, input.laneConcurrency)}>
            {selected.map((n) => {
              const issue = issueFor(n);
              const cwd = cwdFor(n);
              const bootstrap = fixed<Json>(ctx, outputs.laneBootstrap, `i${n}:lane-bootstrap`);
              const refresh = fixed<Json>(ctx, outputs.liveRefresh, `i${n}:live-refresh`);
              return (
                <Sequence key={String(n)}>
                  <Task id={`i${n}:lane-bootstrap`} output={outputs.laneBootstrap}>
                    {() => {
                      const oldBase = value(git(["rev-parse", "refs/heads/main"], root));
                      const url = origin(root);
                      const pushUrl = pushOrigin(root);
                      const canonical = canonicalOrigin(root);
                      const fetch = canonical
                        ? fetchCanonicalMain(root)
                        : denied(["git", "fetch"], "canonical remote precondition failed");
                      const latest = remoteSha(root);
                      const created = fetch.ok && latest ? ensureDetachedWorktree(cwd, latest) : { ok: false };
                      const head = created.ok ? value(git(["rev-parse", "HEAD"], cwd)) : "";
                      const clean = created.ok && status(cwd) === "";
                      return {
                        issueNumber: n,
                        ready: fetch.ok && created.ok && canonical && clean && head === latest,
                        canonicalOrigin: canonical,
                        originUrl: url,
                        pushUrl,
                        fetchExitCode: fetch.exitCode,
                        oldBaseSha: oldBase,
                        baseSha: latest,
                        headSha: head,
                        clean,
                        decision: fetch.ok && created.ok && head === latest ? "ready" : "defer",
                        summary:
                          "A detached pristine lane fetched canonical origin/main and recorded its own latest immutable base without engine worktree resynchronization.",
                      };
                    }}
                  </Task>
                  {bootstrap?.ready === true ? (
                    <Branch
                      if
                      then={
                        <Task id={`i${n}:live-refresh`} output={outputs.liveRefresh}>
                          {() => {
                            const currentIssue = fetchIssue(n);
                            let freshIssues: Json[] = [];
                            let globalEnumerationOk = true;
                            try {
                              freshIssues = discoverOpenIssues().issues;
                            } catch {
                              globalEnumerationOk = false;
                            }
                            const fetch = fetchCanonicalMain(cwd);
                            const currentOrigin = remoteSha(cwd);
                            const fixes = fetch.ok ? matchingFixes(n, currentOrigin, cwd) : [];
                            const equivalents = fetch.ok ? equivalentIssueCommits(n, currentOrigin, cwd) : [];
                            const ownDisposition = ledger.dispositions.find((d: Json) => d.issueNumber === n);
                            const otherPaths = ledger.dispositions
                              .filter((d: Json) => d.issueNumber !== n && d.disposition === "admitted")
                              .flatMap((d: Json) => d.likelyPaths);
                            const activeOverlap =
                              ownDisposition?.likelyPaths.some((path: string) =>
                                otherPaths.some((other: string) => pathsOverlap(path, other)),
                              ) === true;
                            const admittedDiscovery = discovery!;
                            const changedSinceClassificationResult = git(
                              ["diff", "--name-only", "-z", admittedDiscovery.baseSha, currentOrigin, "--"],
                              cwd,
                            );
                            const changedSinceClassification = changedSinceClassificationResult.ok
                              ? changedSinceClassificationResult.stdout.split("\0").filter(Boolean)
                              : [];
                            const classificationCollision =
                              !changedSinceClassificationResult.ok ||
                              changedSinceClassification.some((path) =>
                                ownDisposition?.likelyPaths.some((likely: string) => pathsOverlap(path, likely)),
                              );
                            const initialIdentities = new Map(
                              admittedDiscovery.issues.map((row: Json) => [row.number, row.identitySha256]),
                            );
                            const globalIndexCurrent =
                              globalEnumerationOk &&
                              freshIssues.length === admittedDiscovery.issues.length &&
                              freshIssues.every((row) => initialIdentities.get(row.number) === row.identitySha256);
                            const collision = activeCollisionPaths(ownDisposition?.likelyPaths ?? [], cwd);
                            const excluded =
                              input.excludeNumbers.includes(n) ||
                              activeOverlap ||
                              !collision.ok ||
                              collision.collisions.length > 0;
                            const identityMatches = currentIssue?.identitySha256 === issue.identitySha256;
                            const baseStillExact = value(git(["rev-parse", "HEAD"], cwd)) === bootstrap.baseSha;
                            const implementReady =
                              fetch.ok &&
                              canonicalOrigin(cwd) &&
                              currentIssue?.state === "open" &&
                              identityMatches &&
                              globalIndexCurrent &&
                              baseStillExact &&
                              !excluded &&
                              changedSinceClassificationResult.ok &&
                              !classificationCollision &&
                              fixes.length === 0 &&
                              equivalents.length === 0;
                            return {
                              issueNumber: n,
                              ready: implementReady,
                              issueOpen: currentIssue?.state === "open",
                              identityMatches,
                              issueIdentitySha256: currentIssue?.identitySha256 ?? "",
                              currentOriginSha: currentOrigin,
                              activeExclusion: excluded,
                              collisionEvidenceOk: collision.ok && changedSinceClassificationResult.ok,
                              globalIndexCurrent,
                              activeCollisionPaths: collision.collisions,
                              matchingFixesCommits: fixes,
                              equivalentCommits: equivalents,
                              recoveryCommitSha: "",
                              recoveryDiffSha256: "",
                              recoveryPatchId: "",
                              recoveryChangedPaths: [],
                              decision: implementReady ? "implement" : "defer",
                              evidence: [
                                `fetch exit ${fetch.exitCode}`,
                                `canonical fetch+push ${canonicalOrigin(cwd)}`,
                                `immutable identity ${currentIssue?.identitySha256 ?? "missing"}`,
                                `fresh global index current ${globalIndexCurrent}`,
                                `lane base exact ${baseStillExact}`,
                                `collision queries complete ${collision.ok && changedSinceClassificationResult.ok}`,
                                `active input/peer/PR/worktree exclusion ${excluded}: ${collision.collisions.join(",") || "none"}`,
                                `classification-path collision ${classificationCollision}`,
                                `target-only Fixes commits ${fixes.join(",") || "none"}`,
                                `candidate patch equivalents ${equivalents.join(",") || "none"}`,
                              ],
                              summary: implementReady
                                ? "Fresh pre-Sol issue, global index, base, origin, active PR/worktree/peer-commit exclusion, target-only Fixes, and collision evidence permits implementation."
                                : fixes.length > 0 || equivalents.length > 0
                                  ? "Historical or equivalent commits require separate careful handling; this riskless sweep defers them without recovery or mutation."
                                  : "Fresh pre-Sol evidence changed, collided, failed a query, or remained uncertain.",
                            };
                          }}
                        </Task>
                      }
                    />
                  ) : null}
                  {refresh?.ready === true && refresh.decision === "implement" && bootstrap ? (
                    <Branch
                      if
                      then={correctionLane(
                        n,
                        issue,
                        bootstrap.baseSha,
                        cwd,
                        input.reviewIterations,
                        ctx,
                        ledger.dispositions.find((d: Json) => d.issueNumber === n)?.likelyPaths ?? [],
                      )}
                    />
                  ) : null}
                </Sequence>
              );
            })}
          </Parallel>
        ) : null}
        {!input.dryRun && ledger?.valid && selected.length ? (
          <MergeQueue id="global-landing-queue" maxConcurrency={1}>
            {selected.map((n) =>
              landingSequence(
                n,
                issueFor(n),
                cwdFor(n),
                input.landingRetries,
                ctx,
                ledger.dispositions.find((d: Json) => d.issueNumber === n)?.likelyPaths ?? [],
              ),
            )}
          </MergeQueue>
        ) : null}
        {(input.dryRun || lanesComplete || selected.length === 0) && discovery && ledger?.coverageComplete ? (
          <Task id="final-rescan" output={outputs.finalRescan}>
            {() => {
              const queryMain = () => {
                const boundary = input.dryRun ? lsRemoteMain(root) : { result: fetchCanonicalMain(root), sha: "" };
                return { result: boundary.result, sha: input.dryRun ? boundary.sha : remoteSha(root) };
              };
              const pre = queryMain();
              const enumeratedBaseSha = pre.sha;
              const found = discoverOpenIssues();
              const post = queryMain();
              const latestMainSha = post.sha;
              const landedCount = terminal.filter((row): row is Json => row?.result === "landed+closed").length;
              const remoteEvidenceOk =
                pre.result.ok && post.result.ok && isNonBlank(enumeratedBaseSha) && enumeratedBaseSha === latestMainSha;
              const initial = new Map(discovery.issues.map((x: Json) => [x.number, x.identitySha256]));
              const changed = found.issues
                .filter((x) => initial.get(x.number) !== x.identitySha256)
                .map((x) => x.number);
              const exclusions = ledger.dispositions
                .filter((d: Json) => d.reason.includes("excluded"))
                .map((d: Json) => d.issueNumber);
              const missingEvidence = ledger.dispositions
                .filter((d: Json) => d.missingRoles.length > 0 || !nonBlankStrings(d.evidence))
                .map((d: Json) => `i${d.issueNumber}:admission`);
              const remainingIndependentlyDeferred = found.issues.every((open: Json) => {
                const disposition = ledger.dispositions.find((d: Json) => d.issueNumber === open.number);
                return (
                  disposition?.disposition === "deferred" &&
                  nonBlankStrings(disposition.evidence) &&
                  disposition.missingRoles.length === 0
                );
              });
              const decision = fixpointDecision({
                discoveredCount: discovery.discoveredCount,
                exclusions,
                missingEvidence,
                newOrEdited: changed,
                landedCount,
                remainingOpen: found.issues.map((x) => x.number),
                remainingIndependentlyNotRiskless: remainingIndependentlyDeferred,
              });
              const fixpoint = discovery.enumerationBaseStable === true && remoteEvidenceOk && decision.fixpoint;
              return {
                enumeratedBaseSha: enumeratedBaseSha || "missing",
                latestMainSha: latestMainSha || "missing",
                remoteEvidenceOk,
                fetchExitCode: post.result.exitCode,
                issueIdentityHashes: found.issues.map((x) => ({
                  issueNumber: x.number,
                  identitySha256: x.identitySha256,
                })),
                newOrEditedIssueNumbers: changed,
                fixpoint,
                complete: pre.result.ok && post.result.ok,
                summary: fixpoint
                  ? "Fresh remote evidence proves both enumeration boundaries equal the enumerated base; complete issue evidence is at a true fixpoint."
                  : "Fixpoint is false: remote main moved/query failed at an enumeration boundary, exclusions or identity changes exist, evidence is missing, or a landing changed the base while issues remain.",
              };
            }}
          </Task>
        ) : null}
        {!input.dryRun && lanesComplete && rescan?.complete === true ? (
          <Branch
            if
            then={
              <Task id="final-sync" output={outputs.finalSync}>
                {() => {
                  const localMain = value(git(["rev-parse", "refs/heads/main"], root));
                  const remote = remoteSha(root);
                  const clean = status(root) === "";
                  const onMain = value(git(["branch", "--show-current"], root)) === "main";
                  return {
                    synchronized: false,
                    deferredToOuterController: true,
                    localMainSha: localMain,
                    remoteMainSha: remote,
                    clean,
                    onMain,
                    fetchExitCode: 0,
                    summary:
                      "Shared-root synchronization is mechanically deferred to the outer controller; this workflow performs no final root fetch, merge, jj operation, or filesystem mutation.",
                  };
                }}
              </Task>
            }
          />
        ) : null}
        {rescan && (input.dryRun || finalSync) ? (
          <Task id="final-report" output={outputs.finalReport}>
            {() => {
              const rows = selected
                .map((n) => fixed<Json>(ctx, outputs.laneTerminal, `i${n}:terminal`))
                .filter((x): x is Json => x !== undefined);
              const missing = selected.filter((n) => !rows.some((row: Json) => row.issueNumber === n));
              const exclusions =
                ledger?.dispositions
                  .filter((d: Json) => d.reason.includes("excluded"))
                  .map((d: Json) => d.issueNumber) ?? [];
              const landed = rows.filter((x: Json) => x.result === "landed+closed").length;
              const remaining = rescan.issueIdentityHashes
                .map((x: Json) => x.issueNumber)
                .filter(
                  (n: number) => !rows.some((row: Json) => row.issueNumber === n && row.result === "landed+closed"),
                );
              const zeroSuccess =
                selected.length === 0 &&
                (discovery?.discoveredCount ?? 0) > 0 &&
                ledger?.coverageComplete === true &&
                exclusions.length === 0 &&
                ledger.dispositions.every(
                  (d: Json) => d.disposition === "deferred" && d.evidence.length > 0 && d.missingRoles.length === 0,
                );
              const truthfulFixpoint =
                rescan.fixpoint &&
                exclusions.length === 0 &&
                missing.length === 0 &&
                !(landed > 0 && remaining.length > 0) &&
                (rows.length === selected.length || zeroSuccess);
              const successful =
                !input.dryRun &&
                finalSync?.deferredToOuterController === true &&
                truthfulFixpoint &&
                ((rows.length === selected.length && rows.every((x) => x.result === "landed+closed")) || zeroSuccess);
              const terminalRows = [
                ...rows.map((x: Json) => ({ issueNumber: x.issueNumber, result: x.result, reason: x.reason })),
                ...missing.map((issueNumber) => ({
                  issueNumber,
                  result: "controller-missing-evidence",
                  reason: `missing terminal node i${issueNumber}:terminal`,
                })),
              ];
              return {
                status: input.dryRun
                  ? ("dry-run" as const)
                  : successful
                    ? ("completed" as const)
                    : ("partial" as const),
                successful,
                discoveredCount: discovery?.discoveredCount ?? 0,
                admitted: selected,
                terminal: terminalRows,
                fixpoint: truthfulFixpoint,
                summary: missing.length
                  ? `Controller partial: missing terminal evidence for ${missing.join(", ")}.`
                  : exclusions.length
                    ? `Externally owned/excluded issues remain: ${exclusions.join(", ")}.`
                    : successful
                      ? "Evidence is complete and shared-root synchronization is explicitly deferred to the outer controller."
                      : input.dryRun
                        ? "Read-only disposition report complete; no mutation, worktree, fetch, approval, or root-sync subtree mounted."
                        : "Run ended with explicit evidence-backed partial/deferred results.",
              };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
