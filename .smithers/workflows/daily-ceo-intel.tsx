// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Daily CEO Intel
// smithers-description: Fetch the prior 24h of AI-agent/orchestration news, dedupe/cluster/rank it deterministically, and compose, verify, render, and publish The Smithers Signal.
// smithers-tags: intel, reporting, publishing, cron
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import AssessPrompt from "../prompts/daily-ceo-intel-assess.mdx";
import LighterSidePrompt from "../prompts/daily-ceo-intel-lighter-side.mdx";
import ComposePrompt from "../prompts/daily-ceo-intel-compose.mdx";

import { archiveIssue } from "../lib/daily-ceo-intel/archive";
import { fetchBluesky } from "../lib/daily-ceo-intel/sources/bluesky";
import { canonicalizeAndDedupe } from "../lib/daily-ceo-intel/dedupe";
import { clusterEvents } from "../lib/daily-ceo-intel/cluster";
import { commitSeenState } from "../lib/daily-ceo-intel/commit";
import {
  loadConfigAndState,
  loadRunConfig,
  loadSources,
  resolveCloudflareCreds,
} from "../lib/daily-ceo-intel/config";
import { openDb } from "../lib/daily-ceo-intel/db";
import { filterToWindow } from "../lib/daily-ceo-intel/filterWindow";
import { fetchGithubReleases } from "../lib/daily-ceo-intel/sources/githubReleases";
import { finalizeRun } from "../lib/daily-ceo-intel/finalize";
import { fetchHn } from "../lib/daily-ceo-intel/sources/hn";
import { fetchLobsters } from "../lib/daily-ceo-intel/sources/lobsters";
import { buildAgentPoolsForSelection, selectModelProvider } from "../lib/daily-ceo-intel/modelProvider";
import { normalize } from "../lib/daily-ceo-intel/normalize";
import { publishIssue } from "../lib/daily-ceo-intel/publish";
import { mergeAssessments, rankAndSelect } from "../lib/daily-ceo-intel/rank";
import { fetchReddit } from "../lib/daily-ceo-intel/sources/reddit";
import { renderIssue } from "../lib/daily-ceo-intel/render";
import { removePreviouslySeen } from "../lib/daily-ceo-intel/seen";
import { fetchRss } from "../lib/daily-ceo-intel/sources/rss";
import { verifyIssue } from "../lib/daily-ceo-intel/verify";
import { computeWindow } from "../lib/daily-ceo-intel/window";
import {
  archiveSchema,
  assertVerifiedSchema,
  clusterEventsSchema,
  commitSchema,
  composeEditorialSchema,
  configOutputSchema,
  curateLighterSideSchema,
  dedupeSchema,
  finalizeSchema,
  makeAssessBatchSchema,
  makeFetchResultSchema,
  mergeAssessmentsSchema,
  normalizeSchema,
  providerSelectionSchema,
  publishSchema,
  rankAndSelectSchema,
  renderSchema,
  seenSchema,
  verifySchema,
  windowFilterSchema,
  windowSchema,
} from "../lib/daily-ceo-intel/schemas";

const DEFAULT_CONFIG_PATH = "config/ceo-intel.json";

const inputSchema = z.object({
  windowEnd: z.string().nullable().default(null).describe("ISO-8601 UTC override for the window end. Null means run start."),
  publishMode: z
    .enum(["auto", "archive-only", "publish"])
    .nullable()
    .default(null)
    .describe("auto publishes to CF KV/R2 when creds are present, else archives locally; archive-only always forces the local path."),
  configPath: z.string().nullable().default(null).describe(`Path to the versioned run config. Defaults to ${DEFAULT_CONFIG_PATH}.`),
});

type NormalizedInput = {
  windowEnd: string | null;
  publishMode: "auto" | "archive-only" | "publish";
  configPath: string;
};

function normalizeInput(raw: z.infer<typeof inputSchema>): NormalizedInput {
  return {
    windowEnd: raw.windowEnd,
    publishMode: raw.publishMode ?? "auto",
    configPath: raw.configPath?.trim() || DEFAULT_CONFIG_PATH,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

// Schema keys below become literal table names in the shared workspace DB
// (see packages/smithers/src/create.js prepareSmithersTables), so every key
// is ceoIntel-prefixed to avoid colliding with another workflow's same-named
// output ("config", "verify", "window", "render", ... are common enough that
// two workflows landing on the same table name would corrupt each other's rows).
const { Workflow, Task, Sequence, Parallel, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  ceoIntelWindow: windowSchema,
  ceoIntelConfig: configOutputSchema,
  ceoIntelProviderSelection: providerSelectionSchema,
  ceoIntelFetchRss: makeFetchResultSchema("rss"),
  ceoIntelFetchGithub: makeFetchResultSchema("githubReleases"),
  ceoIntelFetchHn: makeFetchResultSchema("hn"),
  ceoIntelFetchLobsters: makeFetchResultSchema("lobsters"),
  ceoIntelFetchReddit: makeFetchResultSchema("reddit"),
  ceoIntelFetchBluesky: makeFetchResultSchema("bluesky"),
  ceoIntelNormalize: normalizeSchema,
  ceoIntelWindowFilter: windowFilterSchema,
  ceoIntelDedupe: dedupeSchema,
  ceoIntelSeen: seenSchema,
  ceoIntelClusters: clusterEventsSchema,
  ceoIntelAssessBatch: makeAssessBatchSchema(),
  ceoIntelMergedAssessments: mergeAssessmentsSchema,
  ceoIntelSelection: rankAndSelectSchema,
  ceoIntelLighterSide: curateLighterSideSchema,
  ceoIntelIssue: composeEditorialSchema,
  ceoIntelVerify: verifySchema,
  ceoIntelRender: renderSchema,
  ceoIntelArchive: archiveSchema,
  ceoIntelPublish: publishSchema,
  ceoIntelCommit: commitSchema,
  ceoIntelFinalize: finalizeSchema,
  ceoIntelAssertVerified: assertVerifiedSchema,
});

export default smithers((ctx) => {
  const input = normalizeInput(ctx.input);

  const windowOut = ctx.outputMaybe(outputs.ceoIntelWindow, { nodeId: "compute-window" });
  const configOut = ctx.outputMaybe(outputs.ceoIntelConfig, { nodeId: "load-config-and-state" });
  const providerSelectionOut = ctx.outputMaybe(outputs.ceoIntelProviderSelection, { nodeId: "select-model-provider" });
  const agentPools = providerSelectionOut
    ? buildAgentPoolsForSelection(providerSelectionOut, { cheap: agents.ceoIntelCheap, strong: agents.ceoIntelStrong })
    : null;

  const fetchRssOut = ctx.outputMaybe(outputs.ceoIntelFetchRss, { nodeId: "fetch-rss" });
  const fetchGithubOut = ctx.outputMaybe(outputs.ceoIntelFetchGithub, { nodeId: "fetch-github-releases" });
  const fetchHnOut = ctx.outputMaybe(outputs.ceoIntelFetchHn, { nodeId: "fetch-hn" });
  const fetchLobstersOut = ctx.outputMaybe(outputs.ceoIntelFetchLobsters, { nodeId: "fetch-lobsters" });
  const fetchRedditOut = ctx.outputMaybe(outputs.ceoIntelFetchReddit, { nodeId: "fetch-reddit" });
  const fetchBlueskyOut = ctx.outputMaybe(outputs.ceoIntelFetchBluesky, { nodeId: "fetch-bluesky" });
  const allFetchesReady = Boolean(fetchRssOut && fetchGithubOut && fetchHnOut && fetchLobstersOut && fetchRedditOut && fetchBlueskyOut);

  const normalizeOut = ctx.outputMaybe(outputs.ceoIntelNormalize, { nodeId: "normalize" });
  const windowFilterOut = ctx.outputMaybe(outputs.ceoIntelWindowFilter, { nodeId: "strict-24h-filter" });
  const dedupeOut = ctx.outputMaybe(outputs.ceoIntelDedupe, { nodeId: "canonicalize-dedupe" });
  const seenOut = ctx.outputMaybe(outputs.ceoIntelSeen, { nodeId: "remove-previously-seen" });
  const clustersOut = ctx.outputMaybe(outputs.ceoIntelClusters, { nodeId: "cluster-events" });

  const batches = clustersOut ? chunk(clustersOut.clusters, loadRunConfig(input.configPath).assessBatchSize) : [];
  const assessBatchOutputs = batches.map((_, index) => ctx.outputMaybe(outputs.ceoIntelAssessBatch, { nodeId: `assess-relevance-b${index}` }));
  const allBatchesReady = assessBatchOutputs.every((row) => row !== undefined);

  const mergedOut = ctx.outputMaybe(outputs.ceoIntelMergedAssessments, { nodeId: "merge-assessments" });
  const selectionOut = ctx.outputMaybe(outputs.ceoIntelSelection, { nodeId: "rank-and-select" });
  const lighterSideOut = ctx.outputMaybe(outputs.ceoIntelLighterSide, { nodeId: "curate-lighter-side" });

  const verifyRows = ctx.outputs.ceoIntelVerify ?? [];
  const attempt = verifyRows.length + 1;
  const latestVerify = ctx.latest(outputs.ceoIntelVerify, "verify");
  const latestIssue = ctx.latest(outputs.ceoIntelIssue, "compose-editorial");

  const renderOut = ctx.outputMaybe(outputs.ceoIntelRender, { nodeId: "render" });
  const archiveOut = ctx.outputMaybe(outputs.ceoIntelArchive, { nodeId: "archive" });
  const publishOut = ctx.outputMaybe(outputs.ceoIntelPublish, { nodeId: "publish" });
  const commitOut = ctx.outputMaybe(outputs.ceoIntelCommit, { nodeId: "commit-seen-state" });
  const finalizeOut = ctx.outputMaybe(outputs.ceoIntelFinalize, { nodeId: "finalize" });

  const lighterSideItems = (lighterSideOut?.picks ?? []).map((pick) => {
    const candidate = selectionOut?.lighterSideCandidates.find((entry) => entry.srcId === pick.srcId);
    return { srcId: pick.srcId, title: candidate?.title ?? "", excerpt: candidate?.excerpt ?? "", whyFunny: pick.whyFunny };
  });

  return (
    <Workflow name="daily-ceo-intel">
      <UI entry="../ui/daily-ceo-intel.tsx" title="The Smithers Signal — Daily CEO Intel" />
      <Sequence>
        <Task id="compute-window" output={outputs.ceoIntelWindow}>
          {() => computeWindow(input.windowEnd, new Date().toISOString())}
        </Task>

        {windowOut ? (
          <Task id="load-config-and-state" output={outputs.ceoIntelConfig}>
            {() => {
              const state = loadConfigAndState(input.configPath, input.publishMode);
              return {
                configPath: input.configPath,
                sourceCount: state.sourceCount,
                criticalSourceIds: state.criticalSourceIds,
                cheapPoolName: state.config.cheapPoolName,
                strongPoolName: state.config.strongPoolName,
                dbPath: state.dbPath,
                schemaCreated: state.schemaCreated,
                cfCredsPresent: state.cfCredsPresent,
                effectiveMode: state.effectiveMode,
                summary: `${state.sourceCount} sources configured; db ${state.schemaCreated ? "created" : "loaded"} at ${state.dbPath}; effective mode ${state.effectiveMode}.`,
              };
            }}
          </Task>
        ) : null}

        {configOut ? (
          <Task id="select-model-provider" output={outputs.ceoIntelProviderSelection}>
            {async () => {
              const selection = await selectModelProvider(process.env);
              return {
                ...selection,
                summary: `provider=${selection.provider} mode=${selection.mode} cheapModel=${selection.cheapModel} strongModel=${selection.strongModel}: ${selection.reason}`,
              };
            }}
          </Task>
        ) : null}

        {configOut ? (
          <Parallel maxConcurrency={3}>
            <Task id="fetch-rss" output={outputs.ceoIntelFetchRss}>
              {async () => {
                const sources = loadSources(input.configPath).rss;
                const rows = await fetchRss(sources);
                return {
                  kind: "rss" as const,
                  sources: rows,
                  itemCount: rows.reduce((sum, row) => sum + row.itemCount, 0),
                  summary: `Fetched ${rows.filter((r) => r.ok).length}/${rows.length} RSS feeds.`,
                };
              }}
            </Task>
            <Task id="fetch-github-releases" output={outputs.ceoIntelFetchGithub}>
              {async () => {
                const sources = loadSources(input.configPath).githubReleases;
                const rows = await fetchGithubReleases(sources);
                return {
                  kind: "githubReleases" as const,
                  sources: rows,
                  itemCount: rows.reduce((sum, row) => sum + row.itemCount, 0),
                  summary: `Fetched ${rows.filter((r) => r.ok).length}/${rows.length} GitHub releases feeds.`,
                };
              }}
            </Task>
            <Task id="fetch-hn" output={outputs.ceoIntelFetchHn}>
              {async () => {
                const sources = loadSources(input.configPath).hn;
                const since = ctx.outputMaybe(outputs.ceoIntelWindow, { nodeId: "compute-window" })?.windowStart ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const rows = await fetchHn(sources, since);
                return {
                  kind: "hn" as const,
                  sources: rows,
                  itemCount: rows.reduce((sum, row) => sum + row.itemCount, 0),
                  summary: `Fetched ${rows.filter((r) => r.ok).length}/${rows.length} HN Algolia queries.`,
                };
              }}
            </Task>
            <Task id="fetch-lobsters" output={outputs.ceoIntelFetchLobsters}>
              {async () => {
                const sources = loadSources(input.configPath).lobsters;
                const rows = await fetchLobsters(sources);
                return {
                  kind: "lobsters" as const,
                  sources: rows,
                  itemCount: rows.reduce((sum, row) => sum + row.itemCount, 0),
                  summary: `Fetched ${rows.filter((r) => r.ok).length}/${rows.length} Lobsters tags.`,
                };
              }}
            </Task>
            <Task id="fetch-reddit" output={outputs.ceoIntelFetchReddit}>
              {async () => {
                const sources = loadSources(input.configPath).reddit;
                const rows = await fetchReddit(sources);
                return {
                  kind: "reddit" as const,
                  sources: rows,
                  itemCount: rows.reduce((sum, row) => sum + row.itemCount, 0),
                  summary: `Fetched ${rows.filter((r) => r.ok).length}/${rows.length} subreddits.`,
                };
              }}
            </Task>
            <Task id="fetch-bluesky" output={outputs.ceoIntelFetchBluesky}>
              {async () => {
                const sources = loadSources(input.configPath).bluesky;
                const rows = await fetchBluesky(sources);
                return {
                  kind: "bluesky" as const,
                  sources: rows,
                  itemCount: rows.reduce((sum, row) => sum + row.itemCount, 0),
                  summary: `Fetched ${rows.filter((r) => r.ok).length}/${rows.length} Bluesky queries.`,
                };
              }}
            </Task>
          </Parallel>
        ) : null}

        {allFetchesReady && configOut ? (
          <Task id="normalize" output={outputs.ceoIntelNormalize}>
            {() => {
              const { db } = openDb(configOut.dbPath);
              return normalize(
                [
                  fetchRssOut!.sources,
                  fetchGithubOut!.sources,
                  fetchHnOut!.sources,
                  fetchLobstersOut!.sources,
                  fetchRedditOut!.sources,
                  fetchBlueskyOut!.sources,
                ],
                configOut.criticalSourceIds,
                db,
                new Date().toISOString(),
              );
            }}
          </Task>
        ) : null}

        {normalizeOut && windowOut ? (
          <Task id="strict-24h-filter" output={outputs.ceoIntelWindowFilter}>
            {() => filterToWindow(normalizeOut.items, windowOut.windowStart, windowOut.windowEnd)}
          </Task>
        ) : null}

        {windowFilterOut ? (
          <Task id="canonicalize-dedupe" output={outputs.ceoIntelDedupe}>
            {() => canonicalizeAndDedupe(windowFilterOut.items)}
          </Task>
        ) : null}

        {dedupeOut && configOut ? (
          <Task id="remove-previously-seen" output={outputs.ceoIntelSeen}>
            {() => {
              const { db } = openDb(configOut.dbPath);
              return removePreviouslySeen(dedupeOut.items, db);
            }}
          </Task>
        ) : null}

        {seenOut ? (
          <Task id="cluster-events" output={outputs.ceoIntelClusters}>
            {() => clusterEvents(seenOut.items)}
          </Task>
        ) : null}

        {clustersOut && batches.length > 0 && agentPools ? (
          <Parallel maxConcurrency={3}>
            {batches.map((batch, index) => (
              <Task
                key={`assess-relevance-b${index}`}
                id={`assess-relevance-b${index}`}
                output={outputs.ceoIntelAssessBatch}
                agent={agentPools.cheap}
                heartbeatTimeoutMs={300_000}
              >
                <AssessPrompt
                  batchIndex={index}
                  clusters={batch.map((c) => ({ srcId: c.srcId, title: c.title, excerpt: c.excerpt, categoryHints: c.categoryHints }))}
                />
              </Task>
            ))}
          </Parallel>
        ) : null}

        {clustersOut && allBatchesReady ? (
          <Task id="merge-assessments" output={outputs.ceoIntelMergedAssessments}>
            {() => mergeAssessments(assessBatchOutputs.map((row) => row!.assessments), clustersOut.srcIdMap)}
          </Task>
        ) : null}

        {mergedOut && clustersOut ? (
          <Task id="rank-and-select" output={outputs.ceoIntelSelection}>
            {() => rankAndSelect(clustersOut.clusters, mergedOut.assessments, loadRunConfig(input.configPath))}
          </Task>
        ) : null}

        {selectionOut && agentPools ? (
          <Task id="curate-lighter-side" output={outputs.ceoIntelLighterSide} agent={agentPools.cheap} heartbeatTimeoutMs={180_000}>
            <LighterSidePrompt candidates={selectionOut.lighterSideCandidates} />
          </Task>
        ) : null}

        {selectionOut && lighterSideOut && clustersOut && windowOut && agentPools ? (
          <Loop id="editorial-repair" maxIterations={2} until={latestVerify?.passed === true} onMaxReached="return-last">
            <Sequence>
              <Task id="compose-editorial" output={outputs.ceoIntelIssue} agent={agentPools.strong} heartbeatTimeoutMs={600_000}>
                <ComposePrompt
                  issueDateEt={windowOut.issueDateEt}
                  topStories={selectionOut.topStories}
                  actions={selectionOut.actions}
                  briefCandidates={selectionOut.briefCandidates}
                  lighterSideItems={lighterSideItems}
                  wordMin={loadRunConfig(input.configPath).composeWordMin}
                  wordMax={loadRunConfig(input.configPath).composeWordMax}
                  attempt={attempt}
                  verifyErrors={latestVerify?.errors ?? []}
                />
              </Task>
              <Task
                id="verify"
                output={outputs.ceoIntelVerify}
                deps={{ compose: outputs.ceoIntelIssue }}
                needs={{ compose: "compose-editorial" }}
              >
                {(deps) =>
                  verifyIssue(
                    deps.compose.issue,
                    clustersOut.srcIdMap,
                    clustersOut.clusters,
                    loadRunConfig(input.configPath),
                    windowOut.windowStart,
                    windowOut.windowEnd,
                    deps.compose.attempt,
                  )
                }
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {latestIssue && clustersOut && normalizeOut && windowOut && windowFilterOut && dedupeOut && mergedOut && selectionOut && providerSelectionOut ? (
          <Task id="render" output={outputs.ceoIntelRender}>
            {() =>
              renderIssue(
                latestIssue.issue,
                clustersOut.srcIdMap,
                normalizeOut.coverage,
                normalizeOut.dateUncertainSample,
                normalizeOut.degraded,
                normalizeOut.criticalFailed,
                {
                  clusters: clustersOut.clusters,
                  rankedTopStories: selectionOut.topStories,
                  windowStart: windowOut.windowStart,
                  windowEnd: windowOut.windowEnd,
                  generatedAt: new Date().toISOString(),
                  totals: {
                    fetched: normalizeOut.itemCount,
                    inWindow: windowFilterOut.inWindowCount,
                    afterDedupe: dedupeOut.uniqueCount,
                    clusters: clustersOut.clusterCount,
                    assessed: mergedOut.assessedCount,
                    selected: selectionOut.selectedCount,
                  },
                },
                {
                  provider: providerSelectionOut.provider,
                  mode: providerSelectionOut.mode,
                  cheapModel: providerSelectionOut.cheapModel,
                  strongModel: providerSelectionOut.strongModel,
                  reason: providerSelectionOut.reason,
                  selectedAt: providerSelectionOut.selectedAt,
                },
              )
            }
          </Task>
        ) : null}

        {renderOut && windowOut && configOut ? (
          <Task id="archive" output={outputs.ceoIntelArchive}>
            {async () => {
              const runConfig = loadRunConfig(input.configPath);
              const creds = configOut.cfCredsPresent ? resolveCloudflareCreds(runConfig) : null;
              return archiveIssue(renderOut, windowOut.issueDateEt, configOut.effectiveMode, configOut.cfCredsPresent, creds, runConfig.reportsDir);
            }}
          </Task>
        ) : null}

        {archiveOut && configOut && windowOut && latestVerify && renderOut && normalizeOut ? (
          <Task id="publish" output={outputs.ceoIntelPublish}>
            {async () => {
              const runConfig = loadRunConfig(input.configPath);
              const creds = resolveCloudflareCreds(runConfig);
              const { db } = openDb(runConfig.dbPath);
              return publishIssue(
                renderOut,
                windowOut.issueDateEt,
                configOut.cfCredsPresent,
                configOut.effectiveMode,
                latestVerify.passed,
                normalizeOut.criticalFailed,
                creds,
                db,
              );
            }}
          </Task>
        ) : null}

        {publishOut && clustersOut && configOut && latestVerify && archiveOut ? (
          <Task id="commit-seen-state" output={outputs.ceoIntelCommit}>
            {() => {
              const runConfig = loadRunConfig(input.configPath);
              const { db } = openDb(runConfig.dbPath);
              const publishOk = publishOut.published || publishOut.idempotentSkip || configOut.effectiveMode === "archive-only";
              const shouldCommit = latestVerify.passed && publishOk;
              const reason = !latestVerify.passed
                ? "The composed issue failed verification."
                : !publishOk
                  ? (publishOut.skippedReason ?? "Publish did not succeed.")
                  : null;
              return commitSeenState(clustersOut.clusters, db, runConfig.fingerprintRetentionDays, new Date().toISOString(), shouldCommit, reason);
            }}
          </Task>
        ) : null}

        {commitOut && renderOut && archiveOut && publishOut && latestVerify && windowOut && normalizeOut && latestIssue && mergedOut ? (
          <Task id="finalize" output={outputs.ceoIntelFinalize}>
            {() =>
              finalizeRun({
                issueDateEt: windowOut.issueDateEt,
                storyCount: renderOut.storyCount,
                actionCount: latestIssue.issue.recommendedActions.length,
                artifactPaths: archiveOut.paths,
                verifyPassed: latestVerify.passed,
                verifyErrors: latestVerify.errors,
                published: publishOut.published,
                degraded: normalizeOut.degraded,
                criticalFailed: normalizeOut.criticalFailed,
                invalidAssessmentCount: mergedOut.invalidCount,
                publishSkippedReason: publishOut.skippedReason,
                commitSkippedReason: commitOut.skippedReason,
              })
            }
          </Task>
        ) : null}

        {finalizeOut ? (
          <Task id="assert-verified" output={outputs.ceoIntelAssertVerified} noRetry>
            {() => {
              if (!latestVerify?.passed) {
                throw new Error(
                  `daily-ceo-intel: issue for ${windowOut?.issueDateEt} failed verification after ${attempt} attempt(s): ${(latestVerify?.errors ?? []).join("; ")}`,
                );
              }
              return { ok: true };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
