/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import type { z } from "zod";

import { agentsForRepo } from "../components/agents";
import {
  cacheKeyForFile,
  fieldKey,
  lifetimeTsv,
  selectLifetimeVerificationRows,
  stableNodeId,
  summarizeLifetimeRows,
} from "../components/porting-rules";
import { standardScorers } from "../components/scorers";
import {
  lifetimeClassificationSchema,
  lifetimeInputSchema,
  lifetimeSelectionSchema,
  lifetimeSummarySchema,
  lifetimeVoteSchema,
  phaseDoneSchema,
} from "../components/schemas";
import LifetimeClassifyPrompt from "../prompts/lifetime-classify.mdx";
import LifetimeVerifyPrompt from "../prompts/lifetime-verify.mdx";

const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers(
  {
    input: lifetimeInputSchema,
    lifetimeClassification: lifetimeClassificationSchema,
    lifetimeSelection: lifetimeSelectionSchema,
    lifetimeVote: lifetimeVoteSchema,
    lifetimeSummary: lifetimeSummarySchema,
    output: phaseDoneSchema,
  },
  { dbPath: process.env.BUN_PORT_SMITHERS_DB ?? "examples/bun-port-smithers/.tmp/smithers.db" },
);

const lifetimeMemory = { kind: "workflow", id: "bun-port-lifetimes" } as const;

export default smithers((ctx) => {
  const files = ctx.input.files ?? [];
  const agents = agentsForRepo(ctx.input.repo);
  const scorers = standardScorers(ctx.input.repo, 20 * 60_000);
  type LifetimeClassification = z.infer<typeof lifetimeClassificationSchema>;
  type LifetimeSelection = z.infer<typeof lifetimeSelectionSchema>;
  type LifetimeVote = z.infer<typeof lifetimeVoteSchema>;
  type LifetimeSummary = z.infer<typeof lifetimeSummarySchema>;

  const classifications = files
    .map((file) =>
      ctx.outputMaybe(outputs.lifetimeClassification, {
        nodeId: `lifetime:classify:${stableNodeId(file.zig)}`,
      }) as LifetimeClassification | undefined
    )
    .filter((row): row is LifetimeClassification => Boolean(row));
  const flatFields = classifications.flatMap((row) => row.fields.map((field) => ({
    ...field,
    file: row.file,
    crate: row.crate,
  })));
  const selected = ctx.outputMaybe(outputs.lifetimeSelection, { nodeId: "lifetime:select-verify" }) as LifetimeSelection | undefined;
  const voteNodeIds = selected
    ? selected.selected.flatMap((field) =>
      [0, 1, 2].map((vote) => `lifetime:verify:${stableNodeId(field.key)}:${vote}`)
    )
    : [];
  const votes = voteNodeIds
    .map((nodeId) => ctx.outputMaybe(outputs.lifetimeVote, { nodeId }) as LifetimeVote | undefined)
    .filter((row): row is LifetimeVote => Boolean(row));
  const summary = ctx.outputMaybe(outputs.lifetimeSummary, { nodeId: "lifetime:synthesize" }) as LifetimeSummary | undefined;
  const expectedVotes = (selected?.selectedCount ?? 0) * 3;

  return (
    <Workflow name="bun-port-lifetime-classify">
      <Sequence>
        <Parallel maxConcurrency={files.length || 1}>
          {files.map((file) => {
            const cacheKey = cacheKeyForFile({
              repo: ctx.input.repo,
              zig: file.zig,
              crate: file.crate,
              portingRevision: ctx.input.portingRevision,
              lifetimeRevision: ctx.input.lifetimeRevision,
            });
            return (
              <Task
                key={file.zig}
                id={`lifetime:classify:${stableNodeId(file.zig)}`}
                output={outputs.lifetimeClassification}
                agent={agents.lifetimeClassifier}
                timeoutMs={20 * 60_000}
                cache={{ by: () => cacheKey, version: "v2" }}
                scorers={scorers}
                memory={{
                  recall: { namespace: lifetimeMemory, query: file.zig, topK: 8 },
                  remember: { namespace: lifetimeMemory, key: `classify:${file.zig}` },
                }}
              >
                <LifetimeClassifyPrompt
                  repo={ctx.input.repo}
                  file={file}
                  cacheKey={cacheKey}
                  schema={lifetimeClassificationSchema}
                />
              </Task>
            );
          })}
        </Parallel>

        {classifications.length >= files.length ? (
          <Task id="lifetime:select-verify" output={outputs.lifetimeSelection}>
            {() => {
              const rows = selectLifetimeVerificationRows(flatFields, ctx.input.sampleRate ?? 0.12);
              return {
                totalFields: flatFields.length,
                selectedCount: rows.length,
                selected: rows.map((field) => ({
                  key: fieldKey(field),
                  file: field.file,
                  struct: field.struct,
                  field: field.field,
                  class: field.class,
                  rustType: field.rustType,
                })),
              };
            }}
          </Task>
        ) : null}

        {selected ? (
          <Parallel maxConcurrency={Math.max(1, Math.min(24, selected.selectedCount * 3))}>
            {selected.selected.flatMap((field) =>
              [0, 1, 2].map((vote) => (
                <Task
                  key={`${field.key}:${vote}`}
                  id={`lifetime:verify:${stableNodeId(field.key)}:${vote}`}
                  output={outputs.lifetimeVote}
                  agent={agents.lifetimeVerifier}
                  timeoutMs={10 * 60_000}
                  scorers={scorers}
                  memory={{
                    recall: { namespace: lifetimeMemory, query: field.key, topK: 5 },
                    remember: { namespace: lifetimeMemory, key: `verify:${field.key}:${vote}` },
                  }}
                >
                  <LifetimeVerifyPrompt
                    repo={ctx.input.repo}
                    field={field}
                    voter={`verifier-${vote + 1}`}
                    schema={lifetimeVoteSchema}
                  />
                </Task>
              )),
            )}
          </Parallel>
        ) : null}

        {selected && votes.length >= expectedVotes ? (
          <Task id="lifetime:synthesize" output={outputs.lifetimeSummary}>
            {() => {
              const base = summarizeLifetimeRows(flatFields);
              const refutedKeys = votes.filter((vote) => vote.refuted).map((vote) => vote.key);
              const tsv = lifetimeTsv(flatFields);
              return {
                totalFields: base.totalFields,
                unknownRate: base.unknownRate,
                verifiedCount: selected.selectedCount,
                overturned: new Set(refutedKeys).size,
                byClass: base.byClass,
                tsvPreview: tsv.split("\n").slice(0, 21).join("\n"),
                tsv,
                refutedKeys: [...new Set(refutedKeys)],
              };
            }}
          </Task>
        ) : null}

        {summary ? (
          <Task id="lifetime:output" output={outputs.output}>
            {{
              phase: "lifetimes",
              status: summary.refutedKeys.length > 0 ? "partial" : "completed",
              summary: `Lifetime classification produced ${summary.totalFields} field row(s), UNKNOWN rate ${summary.unknownRate}.`,
              unknownRate: summary.unknownRate,
              totalFields: summary.totalFields,
              refutedKeys: summary.refutedKeys,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
