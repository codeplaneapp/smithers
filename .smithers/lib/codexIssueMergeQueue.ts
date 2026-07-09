export type IssueKeyed = { issueNumber: number };

export type PullRequestHead = IssueKeyed & {
  prepared: boolean;
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

export type CiVerdict = IssueKeyed & {
  passed: boolean;
  headSha: string;
  phase?: "candidate" | "queue" | "land";
};

export type ReadinessVerdict = IssueKeyed & {
  ready: boolean;
  headSha: string;
};

export type PanelWinner = "sol" | "fable" | "tie";

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
 * A review and CI result only bless the candidate revision they actually saw.
 * This prevents an approval from an earlier loop pass being reused after Luna
 * changes the branch (or after a rebase changes the PR head).
 */
export function candidateIsReady(
  pr: PullRequestHead | undefined,
  review: ReviewVerdict | undefined,
  ci: CiVerdict | undefined,
): boolean {
  if (!pr?.prepared || !pr.headSha) return false;
  return review?.approved === true && review.headSha === pr.headSha && ci?.passed === true && ci.headSha === pr.headSha;
}

export function issueIsReady(
  issueNumber: number,
  prs: PullRequestHead[] | undefined,
  reviews: ReviewVerdict[] | undefined,
  panelReviews: PanelReviewVerdict[] | undefined,
  checks: CiVerdict[] | undefined,
): boolean {
  const pr = latestForIssue(prs, issueNumber);
  const panelApproved = (["sol", "fable"] as const).every((reviewer) => {
    const latest = latestForIssue(
      (panelReviews ?? []).filter((review) => review.reviewer === reviewer),
      issueNumber,
    );
    return latest?.approved === true && latest.headSha === pr?.headSha;
  });
  return candidateIsReady(
    pr,
    latestForIssue(reviews, issueNumber),
    latestForIssue((checks ?? []).filter((check) => check.phase === undefined || check.phase === "candidate"), issueNumber),
  ) && panelApproved;
}

export function mergeIsVerified(
  merge: {
    status?: string;
    headSha?: string;
    localMainSha?: string;
    gatePassed?: boolean;
    githubPassed?: boolean;
    verified?: boolean;
  } | undefined,
): boolean {
  return merge?.status === "merged"
    && !!merge.headSha
    && merge.localMainSha === merge.headSha
    && merge.gatePassed === true
    && merge.githubPassed === true
    && merge.verified === true;
}

export function queueCandidateIsReady(
  issueNumber: number,
  preflights: ReadinessVerdict[] | undefined,
  checks: CiVerdict[] | undefined,
): boolean {
  const preflight = latestForIssue(preflights, issueNumber);
  const ci = latestForIssue((checks ?? []).filter((check) => check.phase === "queue"), issueNumber);
  return preflight?.ready === true && !!preflight.headSha && ci?.passed === true && ci.headSha === preflight.headSha;
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
