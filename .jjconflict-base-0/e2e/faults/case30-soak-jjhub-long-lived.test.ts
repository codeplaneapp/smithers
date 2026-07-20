import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { Effect } from "effect";
import { z } from "zod";
import {
  Task,
  Workflow,
  createSmithers,
  runWorkflow,
} from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { loadBudget } from "../budgets/loadBudget.ts";

const SOAK_ENABLED = process.env.SMITHERS_E2E_SOAK === "1";
const RUN_COUNT = Number(process.env.SMITHERS_E2E_SOAK_RUNS ?? 500);
const SAMPLE_INTERVAL_MS = 1_000;

function tryGc(): void {
  const bunGc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun
    ?.gc;
  if (typeof bunGc === "function") bunGc(true);
}

describe("case 30: Long-lived workspace runtime, repeated runs; stable behavior", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test.skipIf(!SOAK_ENABLED)(
    "repeated real workflow runs preserve workspace files and run history within the RSS budget",
    async () => {
      if (!Number.isSafeInteger(RUN_COUNT) || RUN_COUNT < 1) {
        throw new Error("SMITHERS_E2E_SOAK_RUNS must be a positive integer");
      }

      const budget = (await loadBudget("memory")) as {
        longLivedRuns500: { rssGrowthBytesMax: number };
      };
      const rssGrowthBudget = budget.longLivedRuns500.rssGrowthBytesMax;
      const root = await mkdtemp(join(tmpdir(), "smithers-case30-workspace-"));
      tempRoots.push(root);
      const artifactsDir = join(root, "artifacts");
      await mkdir(artifactsDir);

      const api = createSmithers(
        {
          input: z.object({ index: z.number().int().nonnegative() }),
          artifact: z.object({ index: z.number().int(), contents: z.string() }),
        },
        { dbPath: join(root, "smithers.db") },
      );
      const adapter = new SmithersDb(api.db);
      const workspaceAgent = {
        id: "case30-workspace-writer",
        tools: {},
        generate: async ({ prompt }: { prompt?: unknown } = {}) => {
          const promptText = typeof prompt === "string" ? prompt : "";
          const match = promptText.match(/artifact-(\d+)\.txt/);
          if (!match)
            throw new Error(`Missing artifact index in prompt: ${prompt}`);
          const index = Number(match[1]);
          const contents = `case30-run-${index}\n`;
          await writeFile(
            join(artifactsDir, `artifact-${index}.txt`),
            contents,
          );
          return { output: { index, contents } };
        },
      };
      const workflow = api.smithers((ctx) =>
        React.createElement(
          Workflow,
          { name: "case30-long-lived-workspace" },
          React.createElement(
            Task,
            {
              id: "write-artifact",
              agent: workspaceAgent,
              output: api.outputs.artifact,
            },
            `Write artifact-${ctx.input.index}.txt`,
          ),
        ),
      );

      tryGc();
      const baselineRss = process.memoryUsage().rss;
      let peakRss = baselineRss;
      const sampleHandle = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, SAMPLE_INTERVAL_MS);

      try {
        for (let index = 0; index < RUN_COUNT; index++) {
          const runId = `case30-run-${index}`;
          const result = await Effect.runPromise(
            runWorkflow(workflow, {
              runId,
              input: { index },
              rootDir: root,
            }),
          );
          expect(result.status).toBe("finished");

          const run = await Effect.runPromise(adapter.getRun(runId));
          expect(run?.runId).toBe(runId);
          expect(run?.status).toBe("finished");
          expect(
            await readFile(join(artifactsDir, `artifact-${index}.txt`), "utf8"),
          ).toBe(`${runId}\n`);
        }

        const artifacts = await readdir(artifactsDir);
        expect(artifacts).toHaveLength(RUN_COUNT);
        expect(new Set(artifacts).size).toBe(RUN_COUNT);

        tryGc();
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        const rssGrowth = peakRss - baselineRss;
        console.log(
          `[case30] realRuns=${RUN_COUNT} files=${artifacts.length} baselineRss=${baselineRss} peakRss=${peakRss} growth=${rssGrowth} growthBudget=${rssGrowthBudget}`,
        );
        expect(rssGrowth).toBeLessThan(rssGrowthBudget);
      } finally {
        clearInterval(sampleHandle);
        (api.db as { $client?: { close?: () => void } }).$client?.close?.();
      }
    },
    RUN_COUNT >= 500 ? 7_200_000 : 120_000,
  );
});
