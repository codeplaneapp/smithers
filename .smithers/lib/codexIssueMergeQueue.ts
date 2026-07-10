export type IssueKeyed = { issueNumber: number };

export type CandidateHead = IssueKeyed & {
  ready: boolean;
  headSha: string;
};

export type ReviewVerdict = IssueKeyed & {
  approved: boolean;
  headSha: string;
};

export type PanelReviewVerdict = ReviewVerdict & {
  reviewer: "sol" | "fable";
};

export type PlanningContribution = IssueKeyed & {
  planner: "sol" | "fable";
};

/** A result from the fixed, sandboxed local verification command. */
export type LocalGateVerdict = IssueKeyed & {
  passed: boolean;
  headSha: string;
  phase?: "candidate" | "landing" | "main";
};

export type ReadinessVerdict = IssueKeyed & {
  ready: boolean;
  headSha: string;
};

export type PanelWinner = "sol" | "fable" | "tie";

export const PROTECTED_AUTOMATION_PATH_PREFIXES = [
  ".github/workflows/",
  ".github/actions/",
  ".github/scripts/",
] as const;

export type IssueScope = {
  issueNumbers?: readonly number[];
  excludeNumbers?: readonly number[];
  labels?: readonly string[];
  excludeAuthors?: readonly string[];
};

export type PublicationCompletion = {
  allRepoMode: boolean;
  localMergesComplete: boolean;
  remoteVerified: boolean;
  finalQueryVerified: boolean;
  blockedIssueNumbers: readonly number[];
  openDiscoveredIssueNumbers: readonly number[];
  finalOpenIssueNumbers: readonly number[];
};

export type RecordedMerge = IssueKeyed & {
  status?: string;
  headSha?: string;
  previousLocalMainSha?: string;
  localMainSha?: string;
  gatePassed?: boolean;
  verified?: boolean;
};

export function panelWinnerFromScore(score: { sol?: number; fable?: number } | undefined): PanelWinner | undefined {
  if (!score || !Number.isFinite(score.sol) || !Number.isFinite(score.fable)) return undefined;
  if (score.sol === score.fable) return "tie";
  return Number(score.sol) > Number(score.fable) ? "sol" : "fable";
}

export function tallyPanelWins(rows: Array<{ panelScore?: { sol?: number; fable?: number; winner?: PanelWinner } }> | undefined): Record<PanelWinner, number> {
  const totals: Record<PanelWinner, number> = { sol: 0, fable: 0, tie: 0 };
  for (const row of rows ?? []) {
    // The numeric comparison is authoritative. A moderator cannot inflate a
    // panelist's win count by returning a winner label that contradicts scores.
    const winner = panelWinnerFromScore(row.panelScore);
    if (winner === "sol" || winner === "fable" || winner === "tie") totals[winner] += 1;
  }
  return totals;
}

export function latestForIssue<T extends IssueKeyed>(rows: T[] | undefined, issueNumber: number): T | undefined {
  const matches = (rows ?? []).filter((row) => row.issueNumber === issueNumber);
  return matches.length > 0 ? matches[matches.length - 1] : undefined;
}

export function planningPanelIsComplete(
  issueNumber: number,
  sol: PlanningContribution | undefined,
  fable: PlanningContribution | undefined,
  moderator: IssueKeyed | undefined,
): boolean {
  return sol?.issueNumber === issueNumber
    && sol.planner === "sol"
    && fable?.issueNumber === issueNumber
    && fable.planner === "fable"
    && moderator?.issueNumber === issueNumber;
}

export function reviewPanelIsComplete(
  issueNumber: number,
  sol: PanelReviewVerdict | undefined,
  fable: PanelReviewVerdict | undefined,
  moderator: ReviewVerdict | undefined,
): boolean {
  return sol?.issueNumber === issueNumber
    && sol.reviewer === "sol"
    && fable?.issueNumber === issueNumber
    && fable.reviewer === "fable"
    && moderator?.issueNumber === issueNumber
    && !!moderator.headSha
    && sol.headSha === moderator.headSha
    && fable.headSha === moderator.headSha;
}

/**
 * A review and local-gate result only bless the candidate revision they saw.
 * This prevents an approval from an earlier loop pass being reused after Luna
 * changes the branch (or after a local rebase changes the candidate head).
 */
export function candidateIsReady(
  candidate: CandidateHead | undefined,
  review: ReviewVerdict | undefined,
  gate: LocalGateVerdict | undefined,
): boolean {
  if (!candidate?.ready || !candidate.headSha) return false;
  return review?.approved === true
    && review.headSha === candidate.headSha
    && gate?.passed === true
    && gate.headSha === candidate.headSha;
}

export function issueIsReady(
  issueNumber: number,
  candidates: CandidateHead[] | undefined,
  reviews: ReviewVerdict[] | undefined,
  panelReviews: PanelReviewVerdict[] | undefined,
  gates: LocalGateVerdict[] | undefined,
): boolean {
  const candidate = latestForIssue(candidates, issueNumber);
  const panelApproved = (["sol", "fable"] as const).every((reviewer) => {
    const latest = latestForIssue(
      (panelReviews ?? []).filter((review) => review.reviewer === reviewer),
      issueNumber,
    );
    return latest?.approved === true && latest.headSha === candidate?.headSha;
  });
  return candidateIsReady(
    candidate,
    latestForIssue(reviews, issueNumber),
    latestForIssue((gates ?? []).filter((gate) => gate.phase === undefined || gate.phase === "candidate"), issueNumber),
  ) && panelApproved;
}

export function mergeIsVerified(
  merge: {
    status?: string;
    headSha?: string;
    localMainSha?: string;
    gatePassed?: boolean;
    verified?: boolean;
  } | undefined,
): boolean {
  return merge?.status === "merged"
    && !!merge.headSha
    && merge.localMainSha === merge.headSha
    && merge.gatePassed === true
    && merge.verified === true;
}

export function recordedMergeChain(
  startingMainSha: string,
  currentMainSha: string,
  merges: readonly RecordedMerge[],
): { valid: boolean; issueNumbers: number[]; terminalSha: string; reachesCurrentMain: boolean; reason: string } {
  const failure = (reason: string, issueNumbers: number[] = [], terminalSha = startingMainSha) => ({
    valid: false,
    issueNumbers,
    terminalSha,
    reachesCurrentMain: false,
    reason,
  });
  if (!startingMainSha || !currentMainSha) return failure("Missing starting or current main revision.");
  const edges = new Map<string, RecordedMerge>();
  const issueEdges = new Map<number, string>();
  for (const merge of merges) {
    if (!mergeIsVerified(merge)) continue;
    if (!merge.previousLocalMainSha || !merge.localMainSha) {
      return failure(`Issue #${merge.issueNumber} has an incomplete recorded merge edge.`);
    }
    const key = `${merge.previousLocalMainSha}\0${merge.localMainSha}\0${merge.issueNumber}`;
    if (edges.has(key)) continue;
    const priorForIssue = issueEdges.get(merge.issueNumber);
    if (priorForIssue && priorForIssue !== key) {
      return failure(`Issue #${merge.issueNumber} has more than one distinct verified merge edge.`);
    }
    issueEdges.set(merge.issueNumber, key);
    edges.set(key, merge);
  }

  const outgoing = new Map<string, RecordedMerge>();
  for (const merge of edges.values()) {
    const existing = outgoing.get(merge.previousLocalMainSha!);
    if (existing && existing.localMainSha !== merge.localMainSha) {
      return failure(`Recorded merge edges branch at ${merge.previousLocalMainSha}.`);
    }
    outgoing.set(merge.previousLocalMainSha!, merge);
  }

  let cursor = startingMainSha;
  const issueNumbers: number[] = [];
  const used = new Set<string>();
  while (outgoing.has(cursor)) {
    const edge = outgoing.get(cursor);
    if (!edge) break;
    const key = `${edge.previousLocalMainSha}\0${edge.localMainSha}\0${edge.issueNumber}`;
    if (used.has(key)) return failure(`Recorded merge chain contains a cycle at ${cursor}.`, issueNumbers, cursor);
    used.add(key);
    issueNumbers.push(edge.issueNumber);
    cursor = edge.localMainSha!;
  }
  if (used.size !== edges.size) {
    return failure("Recorded merge rows contain a verified branch or orphan outside the published chain.", issueNumbers, cursor);
  }
  const reachesCurrentMain = cursor === currentMainSha;
  return {
    valid: true,
    issueNumbers,
    terminalSha: cursor,
    reachesCurrentMain,
    reason: reachesCurrentMain
      ? "Recorded merge chain exactly reaches current main."
      : `Recorded merge chain safely ends at ${cursor}; current local main ${currentMainSha} has an unrecorded suffix.`,
  };
}

/**
 * Global completion is meaningful only when issue discovery was not narrowed.
 * `maxIssues` is intentionally not a scope filter: an authoritative final
 * repository query catches any issue left outside that processing batch.
 */
export function isUnfilteredAllRepoMode(scope: IssueScope): boolean {
  return (scope.issueNumbers?.length ?? 0) === 0
    && (scope.excludeNumbers?.length ?? 0) === 0
    && (scope.labels?.length ?? 0) === 0
    && (scope.excludeAuthors?.length ?? 0) === 0;
}

export function publicationIsSuccessful(completion: PublicationCompletion): boolean {
  if (!completion.localMergesComplete || !completion.remoteVerified || !completion.finalQueryVerified) return false;
  if (completion.blockedIssueNumbers.length > 0 || completion.openDiscoveredIssueNumbers.length > 0) return false;
  return !completion.allRepoMode || completion.finalOpenIssueNumbers.length === 0;
}

export function uniqueSortedIssueNumbers(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

/** Public issue agents may not change automation that receives repository credentials. */
export function protectedAutomationPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => {
    if (!path || path.includes("\0")) return true;
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) return true;
    return PROTECTED_AUTOMATION_PATH_PREFIXES.some((prefix) =>
      normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
    );
  }))].sort();
}

export function parsePaginatedOpenIssueNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error("Authoritative open-issue query returned a non-array response.");
  if (!value.every((page) => Array.isArray(page))) throw new Error("Authoritative open-issue pagination returned a malformed page.");
  const issueNumbers: number[] = [];
  for (const row of value.flat() as unknown[]) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Authoritative open-issue pagination returned a malformed row.");
    const record = row as Record<string, unknown>;
    const number = Number(record.number);
    if (!Number.isInteger(number) || number <= 0 || String(record.state ?? "").toLowerCase() !== "open") {
      throw new Error("Authoritative open-issue pagination returned a row with invalid number or state.");
    }
    if (!record.pull_request) issueNumbers.push(number);
  }
  return uniqueSortedIssueNumbers(issueNumbers);
}

export function classifyExistingIssueState(
  state: string,
  stateReason: string,
  expectedReason: "COMPLETED" | "NOT_PLANNED",
): "open" | "already-closed-matching" | "already-closed-other" {
  if (state.toUpperCase() !== "CLOSED") return "open";
  return stateReason.toUpperCase() === expectedReason ? "already-closed-matching" : "already-closed-other";
}

/** Normalize the common GitHub URL forms without ever retaining credentials. */
export function githubRepoFromRemote(remote: string): string | null {
  const value = remote.trim();
  const scp = value.match(/^(?:[^@/\s]+@)?github\.com:([^/\s]+\/[^/\s]+?)\/?$/i);
  if (scp) return normalizeRepoSlug(scp[1]);
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    return normalizeRepoSlug(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function normalizeRepoSlug(value: string): string | null {
  const withoutGit = value.replace(/\.git$/i, "").replace(/\/$/, "");
  const parts = withoutGit.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[a-z0-9_.-]+$/i.test(part))) return null;
  return `${parts[0]}/${parts[1]}`;
}

/**
 * Build an exact-object, non-force refspec. Callers still use ordinary
 * `git push` so Git rejects a non-fast-forward race at the remote.
 */
export function exactShaPushRefspec(sha: string, branch: string): string {
  if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error(`Invalid Git object id: ${sha}`);
  const hasControlOrSpace = [...branch].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
  if (
    !branch
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.endsWith(".lock")
    || branch.includes("..")
    || branch.includes("@{")
    || branch.includes("//")
    || hasControlOrSpace
    || /[~^:?*[\]\\]/.test(branch)
  ) throw new Error(`Invalid branch name: ${branch}`);
  return `${sha}:refs/heads/${branch}`;
}

export function clampIssueConcurrency(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 16;
  return Math.max(1, Math.min(16, Math.trunc(parsed)));
}

export function clampRunConcurrency(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 32;
  return Math.max(1, Math.min(32, Math.trunc(parsed)));
}

export function boundedLog(value: string, maxBytes = 16_000): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return `[truncated to final ${maxBytes} bytes]\n${bytes.subarray(start).toString("utf8")}`;
}
