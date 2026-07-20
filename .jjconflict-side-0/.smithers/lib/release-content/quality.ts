import type {
  DeterministicCheck,
  EditedContent,
  ReleaseAnalysis,
  ReleaseContentInput,
  ScoreReport,
} from "./schemas";

type Issue = DeterministicCheck["issues"][number];

const SUPERLATIVE_PATTERNS = [
  /\bbest\b/i,
  /\bfastest\b/i,
  /\bsafest\b/i,
  /\bfirst ever\b/i,
  /\bindustry[- ]leading\b/i,
  /\bzero downtime\b/i,
  /\bguaranteed\b/i,
];

function lowerIncludes(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase());
}

function allContentText(content: EditedContent): string {
  return [
    content.changelog?.markdown ?? "",
    ...(content.tweetThread?.tweets ?? []).map((tweet) => tweet.text),
    content.blogPost?.markdown ?? "",
  ].join("\n\n");
}

function addIssue(issues: Issue[], issue: Issue): void {
  issues.push(issue);
}

function validateClaimIds(
  issues: Issue[],
  channel: Issue["channel"],
  claimIds: string[],
  analysis: ReleaseAnalysis,
  requireClaimLedger: boolean,
): void {
  const validClaims = new Map(analysis.claimLedger.map((claim) => [claim.id, claim]));
  if (requireClaimLedger && claimIds.length === 0) {
    addIssue(issues, {
      severity: "major",
      channel,
      issue: "Content does not cite any claim ids.",
      fix: "Attach claimIds from the release analysis claimLedger to each generated channel.",
    });
  }
  for (const id of claimIds) {
    const claim = validClaims.get(id);
    if (!claim) {
      addIssue(issues, {
        severity: "blocker",
        channel,
        issue: `Unknown claim id "${id}".`,
        fix: "Use only claim ids present in releaseAnalysis.claimLedger.",
      });
      continue;
    }
    if (!claim.allowedInMarketing) {
      addIssue(issues, {
        severity: "blocker",
        channel,
        issue: `Claim id "${id}" is not allowed in marketing.`,
        fix: "Remove the claim or update the claim ledger with support.",
      });
    }
    if (claim.sources.length === 0) {
      addIssue(issues, {
        severity: "blocker",
        channel,
        issue: `Claim id "${id}" has no source references.`,
        fix: "Attach a commit, file, changelog, package, or manual source to the claim.",
      });
    }
  }
}

export function runDeterministicChecks(params: {
  input: ReleaseContentInput;
  analysis: ReleaseAnalysis;
  content: EditedContent;
}): DeterministicCheck {
  const { input, analysis, content } = params;
  const issues: Issue[] = [];
  const text = allContentText(content);

  for (const phrase of input.quality.bannedPhrases) {
    if (phrase && lowerIncludes(text, phrase)) {
      addIssue(issues, {
        severity: "blocker",
        channel: "all",
        issue: `Banned phrase found: "${phrase}".`,
        fix: "Replace hype language with concrete Smithers nouns and user-visible behavior.",
      });
    }
  }

  for (const pattern of SUPERLATIVE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      addIssue(issues, {
        severity: "major",
        channel: "all",
        issue: `Unsupported superlative or absolute claim found: "${match[0]}".`,
        fix: "Remove the absolute claim unless the claim ledger contains direct proof.",
      });
    }
  }

  if (input.channels.tweetThread && !input.skip.tweetThread && content.tweetThread) {
    for (const tweet of content.tweetThread.tweets) {
      const actualLength = [...tweet.text].length;
      if (actualLength > input.tweetThread.maxChars) {
        addIssue(issues, {
          severity: "blocker",
          channel: "tweetThread",
          issue: `Tweet ${tweet.index} is ${actualLength} characters, over ${input.tweetThread.maxChars}.`,
          fix: "Shorten the tweet before publishing.",
        });
      }
      if (tweet.charCount !== actualLength) {
        addIssue(issues, {
          severity: "minor",
          channel: "tweetThread",
          issue: `Tweet ${tweet.index} reports charCount ${tweet.charCount}, actual length is ${actualLength}.`,
          fix: "Set charCount to the actual Unicode character count.",
        });
      }
      validateClaimIds(issues, "tweetThread", tweet.claimIds, analysis, input.quality.requireClaimLedger);
    }
    if (content.tweetThread.tweets.length > input.tweetThread.maxTweets) {
      addIssue(issues, {
        severity: "blocker",
        channel: "tweetThread",
        issue: `Thread has ${content.tweetThread.tweets.length} tweets, over maxTweets ${input.tweetThread.maxTweets}.`,
        fix: "Reduce the thread length or raise tweetThread.maxTweets deliberately.",
      });
    }
  }

  if (input.channels.changelog && !input.skip.changelog && content.changelog) {
    validateClaimIds(
      issues,
      "changelog",
      content.changelog.claimIds,
      analysis,
      input.quality.requireClaimLedger,
    );
  }

  if (input.channels.blogPost && !input.skip.blogPost && content.blogPost) {
    validateClaimIds(
      issues,
      "blogPost",
      content.blogPost.claimIds,
      analysis,
      input.quality.requireClaimLedger,
    );
    if (content.blogPost.wordCount < Math.floor(input.blogPost.targetWords * 0.45)) {
      addIssue(issues, {
        severity: "minor",
        channel: "blogPost",
        issue: `Blog post is ${content.blogPost.wordCount} words, well below targetWords ${input.blogPost.targetWords}.`,
        fix: "Expand the core explanation or reduce blogPost.targetWords.",
      });
    }
  }

  if (input.publish && input.dryRun) {
    addIssue(issues, {
      severity: "minor",
      channel: "all",
      issue: "publish=true is set, but dryRun=true blocks all side effects.",
      fix: "Set dryRun=false only after preview artifacts and approval are ready.",
    });
  }

  if (input.publish && input.skip.scoring) {
    addIssue(issues, {
      severity: "blocker",
      channel: "all",
      issue: "Publishing with skip.scoring=true is not allowed.",
      fix: "Enable scoring before publishing.",
    });
  }

  if (input.publish && !input.dryRun && input.skip.approval && !input.allowUnreviewedPublish) {
    addIssue(issues, {
      severity: "blocker",
      channel: "all",
      issue: "Refusing to publish with approval skipped unless allowUnreviewedPublish=true.",
      fix: "Do not skip approval, or explicitly set allowUnreviewedPublish=true for an emergency path.",
    });
  }

  return {
    passed: !issues.some((issue) => issue.severity === "blocker"),
    issues,
  };
}

export function enforceQualityGate(params: {
  input: ReleaseContentInput;
  check: DeterministicCheck;
  score: ScoreReport | null | undefined;
}): { ok: boolean; message: string } {
  const { input, check, score } = params;
  const blockers = check.issues.filter((issue) => issue.severity === "blocker");
  if (blockers.length > 0) {
    throw new Error(
      `Release content failed deterministic checks:\n${blockers
        .map((issue) => `- [${issue.channel}] ${issue.issue} ${issue.fix}`)
        .join("\n")}`,
    );
  }
  if (!input.skip.scoring) {
    if (!score) {
      throw new Error("Release content scoring did not produce a score report.");
    }
    if (score.score < input.quality.minScore || !score.passed) {
      throw new Error(
        `Release content score ${score.score} did not meet minScore ${input.quality.minScore}.\n${score.issues
          .map((issue) => `- [${issue.severity}/${issue.channel}] ${issue.issue} ${issue.fix}`)
          .join("\n")}`,
      );
    }
  }
  return { ok: true, message: "Release content passed deterministic and scoring gates." };
}
