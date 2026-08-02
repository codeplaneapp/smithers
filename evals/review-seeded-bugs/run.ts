import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOutputs } from "@smthrs/db/snapshot";
import { runWorkflow } from "@smthrs/engine";
import { Effect } from "effect";
import { parseJsonColumn } from "../../apps/review/src/cli/parseJsonColumn";
import { createReviewAgents } from "../../apps/review/src/workflow/createReviewAgents";
import { createReviewWorkflow } from "../../apps/review/src/workflow/createReviewWorkflow";
import { reviewRunOutputSchema } from "../../apps/review/src/workflow/openCodeReview";
import { loadCorpus, type PlantedBugLabel } from "./labels";
import { scoreCorpus, type CorpusScore, type ReviewFinding } from "./score";

const corpusDir = join(import.meta.dir, "corpus");

type FixtureRun = {
  fixture: string;
  runId: string;
  status: string;
  findings: ReviewFinding[];
};

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}

function copyDirectoryContents(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    cpSync(join(from, entry.name), join(to, entry.name), { recursive: true, force: true });
  }
}

function clearWorktree(repoDir: string): void {
  for (const entry of readdirSync(repoDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    rmSync(join(repoDir, entry.name), { recursive: true, force: true });
  }
}

function materializeFixture(label: PlantedBugLabel, workRoot: string): string {
  const fixtureDir = join(corpusDir, label.fixture);
  const baseDir = join(fixtureDir, "base");
  const headDir = join(fixtureDir, "head");
  if (!existsSync(baseDir) || !existsSync(headDir)) {
    throw new Error(`Fixture ${label.fixture} must have base/ and head/ directories`);
  }

  const repoDir = join(workRoot, "repo");
  copyDirectoryContents(baseDir, repoDir);
  run("git", ["init"], repoDir);
  run("git", ["config", "user.email", "review-seeded-bugs@example.com"], repoDir);
  run("git", ["config", "user.name", "Review Seeded Bugs"], repoDir);
  run("git", ["config", "commit.gpgsign", "false"], repoDir);
  run("git", ["add", "."], repoDir);
  run("git", ["commit", "-m", "base"], repoDir);

  clearWorktree(repoDir);
  copyDirectoryContents(headDir, repoDir);
  return repoDir;
}

function commentsFromReviewRow(row: Record<string, unknown> | undefined): ReviewFinding[] {
  if (!row) throw new Error("Review workflow did not write a review or final output row");
  const output = reviewRunOutputSchema.parse({
    ...row,
    comments: parseJsonColumn(row.comments),
    warnings: parseJsonColumn(row.warnings),
  });
  return output.comments;
}

async function runFixture(label: PlantedBugLabel, reportDir: string): Promise<FixtureRun> {
  const workRoot = mkdtempSync(join(tmpdir(), `review-seeded-${label.fixture}-`));
  try {
    const repoDir = materializeFixture(label, workRoot);
    const agents = createReviewAgents(repoDir);
    const dbPath = join(reportDir, `${label.fixture}.db`);
    const { workflow, db, tables } = createReviewWorkflow({
      dbPath,
      reviewAgents: agents.review,
      verifyAgents: agents.verify,
      narratorAgents: [],
      quizAgents: [],
    });
    const runId = `review-seeded-${label.fixture}-${Date.now()}`;
    const result = (await Effect.runPromise(
      runWorkflow(workflow as never, {
        input: { repo: repoDir, runReview: true, narrate: false, quiz: "off", verify: true },
        runId,
        allowNetwork: true,
      }) as never,
    )) as { status: string };

    const rows = (await loadOutputs(db as never, tables as never, runId)) as Record<
      string,
      Record<string, unknown>[]
    >;
    const row = rows.final?.at(-1) ?? rows.review?.at(-1);
    return {
      fixture: label.fixture,
      runId,
      status: result.status,
      findings: commentsFromReviewRow(row),
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
}

function percent(value: number | null): string {
  return value == null ? "n/a" : `${Math.round(value * 1000) / 10}%`;
}

function numberOrNa(value: number | null): string {
  return value == null ? "n/a" : String(Math.round(value * 1000) / 1000);
}

function labelKind(label: PlantedBugLabel): string {
  return label.clean ? "clean" : label.bugClass;
}

function renderScorecard(labels: readonly PlantedBugLabel[], score: CorpusScore, generatedAt: string): string {
  const labelsByFixture = new Map(labels.map((label) => [label.fixture, label]));
  const lines = [
    "# Review Seeded-Bug Scorecard",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Overall",
    "",
    `- Recall: ${percent(score.recall)} (${score.counts.truePositives}/${score.counts.plantedBugs})`,
    `- Precision: ${percent(score.precision)} (${score.counts.truePositives}/${score.counts.truePositives + score.counts.falsePositives})`,
    `- Mean anchor offset: ${numberOrNa(score.anchorAccuracy.meanLineOffset)} lines`,
    `- Mean absolute anchor offset: ${numberOrNa(score.anchorAccuracy.meanAbsoluteLineOffset)} lines`,
    `- Tight-anchor rate: ${percent(score.anchorAccuracy.fractionWithinTightTolerance)}`,
    `- Severity exact-match rate: ${percent(score.severityCalibration.exactSeverityMatchRate)}`,
    `- Mean severity ordinal error: ${numberOrNa(score.severityCalibration.meanAbsoluteOrdinalError)}`,
    "",
    "## Fixtures",
    "",
    "| Fixture | Label | Findings | TP | FP | FN |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];

  for (const fixture of score.fixtures) {
    const label = labelsByFixture.get(fixture.fixture);
    lines.push(
      `| ${fixture.fixture} | ${label ? labelKind(label) : "unknown"} | ${fixture.findings} | ${fixture.matches} | ${fixture.falsePositives} | ${fixture.falseNegatives} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

export async function main(): Promise<void> {
  const labels = loadCorpus();
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const reportDir = join(import.meta.dir, ".report", stamp);
  mkdirSync(reportDir, { recursive: true });

  const runs: FixtureRun[] = [];
  const findingsByFixture: Record<string, ReviewFinding[]> = {};
  for (const label of labels) {
    const run = await runFixture(label, reportDir);
    runs.push(run);
    findingsByFixture[label.fixture] = run.findings;
  }

  const score = scoreCorpus(labels, findingsByFixture);
  const generatedAt = new Date().toISOString();
  const scorecard = renderScorecard(labels, score, generatedAt);
  writeFileSync(
    join(reportDir, "report.json"),
    JSON.stringify({ generatedAt, labels, runs, findingsByFixture, score }, null, 2),
  );
  writeFileSync(join(reportDir, "SCORECARD.md"), scorecard);
  console.log(scorecard);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
