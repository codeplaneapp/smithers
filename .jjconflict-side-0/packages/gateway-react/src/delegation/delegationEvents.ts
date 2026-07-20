/**
 * The Effect-native event vocabulary of the delegation fold.
 *
 * Every durable `DelegationRecord` is classified into exactly one
 * `DelegationEvent` (a `Data.TaggedEnum`) before the fold consumes it, so the
 * fold itself is driven by `Match.tagsExhaustive` over event tags instead of
 * string switches. Classification is TOTAL: unknown tables and malformed rows
 * classify to the `Ignored` variant (carrying the reason), which the fold
 * routes to `options.onIgnored` — the reducer never throws on bad data.
 */

import { Data, Match } from "effect";
import type {
  DcDevPreviewRow,
  DcEditRow,
  DcExecRow,
  DcGatesRow,
  DcGoalRow,
  DcPlanRow,
  DcPreviewRow,
  DcProbeRow,
  DcQuestionRow,
  DcReplanRow,
  DcReviewRow,
  DelegationRecord,
} from "./types.ts";
import {
  isDcDevPreviewRow,
  isDcEditRow,
  isDcExecRow,
  isDcGatesRow,
  isDcGoalRow,
  isDcPlanRow,
  isDcPollRow,
  isDcPreviewRow,
  isDcProbeRow,
  isDcQuestionRow,
  isDcReplanRow,
  isDcReviewRow,
  isDcSkipRow,
  isDelegationApprovalRecord,
} from "./types.ts";

/** Why a record was excluded from the fold. */
export type DelegationIgnoreReason = "unknown-table" | "malformed-row";

/** Phase-ordered table priority — the sort key's leading component. */
export const TABLE_PRIORITY: Record<string, number> = {
  dcGoal: 0,
  dcQuestion: 1,
  dcPlan: 2,
  dcPreview: 3,
  dcGates: 4,
  dcProbe: 5,
  dcEdit: 6,
  dcReplan: 7,
  dcExec: 8,
  dcReview: 9,
  dcDevPreview: 10,
  dcSkip: 11,
  dcPoll: 12,
  dcScore: 13,
  _approval: 14,
};

/**
 * One classified delegation event. Tags mirror the durable output tables
 * (plus the `_approval` marker and the `Ignored` sink); payloads carry the
 * validated row so downstream stages never re-validate.
 */
export type DelegationEvent = Data.TaggedEnum<{
  GoalRefined: { readonly row: DcGoalRow };
  QuestionAsked: { readonly row: DcQuestionRow };
  PlanDeclared: { readonly row: DcPlanRow };
  PreviewWritten: { readonly row: DcPreviewRow };
  GatesDeclared: { readonly row: DcGatesRow };
  ProbeReported: { readonly row: DcProbeRow };
  ReplanDecided: { readonly row: DcReplanRow };
  ExecFinished: { readonly row: DcExecRow };
  ReviewVerdict: { readonly row: DcReviewRow };
  DevPreviewBuilt: { readonly row: DcDevPreviewRow; readonly iteration: number };
  EditDelivered: { readonly row: DcEditRow };
  PreviewsSkipped: {};
  PollSubmitted: {};
  ScoreReported: { readonly key: string; readonly row: unknown };
  ApprovalMarked: { readonly nodeId: string; readonly iteration: number; readonly pending: boolean };
  Ignored: { readonly record: DelegationRecord; readonly reason: DelegationIgnoreReason };
}>;

export const DelegationEvent = Data.taggedEnum<DelegationEvent>();

/**
 * Classify one durable record into its `DelegationEvent`. Total by
 * construction: the table dispatch is a `Match.value` chain whose `orElse` is
 * the unknown-table sink, and every table arm degrades to `Ignored`
 * (`malformed-row`) when the row guard rejects the payload.
 */
export function classifyDelegationRecord(record: DelegationRecord): DelegationEvent {
  if (record.table === "_approval") {
    return isDelegationApprovalRecord(record)
      ? DelegationEvent.ApprovalMarked({
          nodeId: record.nodeId,
          iteration: record.iteration ?? 0,
          pending: record.pending,
        })
      : DelegationEvent.Ignored({ record, reason: "malformed-row" });
  }
  const row = (record as { row?: unknown }).row;
  const malformed = () => DelegationEvent.Ignored({ record, reason: "malformed-row" });
  return Match.value(record.table).pipe(
    Match.when("dcGoal", () => (isDcGoalRow(row) ? DelegationEvent.GoalRefined({ row }) : malformed())),
    Match.when("dcQuestion", () => (isDcQuestionRow(row) ? DelegationEvent.QuestionAsked({ row }) : malformed())),
    Match.when("dcPlan", () => (isDcPlanRow(row) ? DelegationEvent.PlanDeclared({ row }) : malformed())),
    Match.when("dcPreview", () => (isDcPreviewRow(row) ? DelegationEvent.PreviewWritten({ row }) : malformed())),
    Match.when("dcGates", () => (isDcGatesRow(row) ? DelegationEvent.GatesDeclared({ row }) : malformed())),
    Match.when("dcProbe", () => (isDcProbeRow(row) ? DelegationEvent.ProbeReported({ row }) : malformed())),
    Match.when("dcReplan", () => (isDcReplanRow(row) ? DelegationEvent.ReplanDecided({ row }) : malformed())),
    Match.when("dcExec", () => (isDcExecRow(row) ? DelegationEvent.ExecFinished({ row }) : malformed())),
    Match.when("dcReview", () => (isDcReviewRow(row) ? DelegationEvent.ReviewVerdict({ row }) : malformed())),
    Match.when("dcDevPreview", () =>
      isDcDevPreviewRow(row)
        ? DelegationEvent.DevPreviewBuilt({ row, iteration: (record as { iteration: number }).iteration })
        : malformed(),
    ),
    Match.when("dcEdit", () => (isDcEditRow(row) ? DelegationEvent.EditDelivered({ row }) : malformed())),
    Match.when("dcSkip", () => (isDcSkipRow(row) ? DelegationEvent.PreviewsSkipped() : malformed())),
    Match.when("dcPoll", () => (isDcPollRow(row) ? DelegationEvent.PollSubmitted() : malformed())),
    Match.when("dcScore", () => {
      const key =
        typeof row === "object" && row !== null && typeof (row as Record<string, unknown>).logicalId === "string"
          ? ((row as Record<string, unknown>).logicalId as string)
          : record.nodeId;
      return DelegationEvent.ScoreReported({ key, row });
    }),
    Match.orElse(() => DelegationEvent.Ignored({ record, reason: "unknown-table" })),
  );
}
