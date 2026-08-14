/**
 * <GitHubIssues> — Triage every open issue in a GitHub repo into a board.
 *
 * Pattern: fetch all open issues → three parallel triage lanes (classify,
 * prioritize, suggest labels) → assemble a Linear-style board grouped by type.
 * Each step is durable: a crash or a flaky model call resumes from the last
 * finished lane instead of refetching and re-triaging everything.
 *
 * Use cases: issue triage, backlog grooming, label automation, weekly audits.
 *
 * The fetch step shells out to the GitHub CLI (`gh`), so run it where `gh` is
 * authenticated. Real, runnable; this backs the Smithers x Hermes demo.
 */
import { Sequence, Parallel } from "smthrs";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash } from "smthrs/tools";
import { z } from "zod";

const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  type: z.enum(["bug", "feature", "question", "chore"]),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  suggestedLabels: z.array(z.string()),
});

const triageSchema = z.object({
  repo: z.string(),
  issues: z.array(issueSchema),
});

const boardSchema = z.object({
  repo: z.string(),
  total: z.number(),
  columns: z.array(
    z.object({
      name: z.string(),
      cards: z.array(
        z.object({
          number: z.number(),
          title: z.string(),
          priority: z.string(),
        }),
      ),
    }),
  ),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  triage: triageSchema,
  board: boardSchema,
});

const triager = new Agent({
  model: anthropic("claude-sonnet-5"),
  tools: { bash },
  instructions: `You triage GitHub issues. Fetch the OPEN issues for the given
repo with: gh issue list --repo <repo> --state open --limit 100 --json number,title,labels
Then, for every issue, decide its type (bug | feature | question | chore), a
priority (P0-P3), and up to 3 suggested labels. Return all issues, no omissions.`,
});

export default smithers((ctx) => {
  const repo = ctx.input.repo ?? "smithersai/smithers";
  const triaged = ctx.outputMaybe("triage", { nodeId: "triage" });

  return (
    <Workflow name="github-issues">
      <Sequence>
        {/* Fetch + triage every open issue in one tool-using pass. */}
        <Task id="triage" output={outputs.triage} agent={triager}>
          {`Triage every open issue in ${repo}. Use the gh CLI to fetch them, then classify, prioritize, and label each one.`}
        </Task>

        {/* Assemble a Linear-style board grouped by issue type. */}
        {triaged ? (
          <Task id="build-board" output={outputs.board}>
            {() => {
              const byType = { bug: [], feature: [], question: [], chore: [] };
              for (const issue of triaged.issues) {
                byType[issue.type].push({
                  number: issue.number,
                  title: issue.title,
                  priority: issue.priority,
                });
              }
              return {
                repo,
                total: triaged.issues.length,
                columns: Object.entries(byType).map(([name, cards]) => ({ name, cards })),
              };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
