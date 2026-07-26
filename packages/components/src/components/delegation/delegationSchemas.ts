import type { z } from "zod";
import {
  tierSchema,
  estimateSchema,
  devPreviewKindSchema,
  gateSchema,
  dcGoalSchema,
  dcQuestionSchema,
  dcForecastSchema,
  dcGoalApprovalSchema,
  dcPlanSchema,
  dcPreviewSchema,
  dcGatesSchema,
  dcDevPreviewSchema,
  dcProbeSchema,
  dcReplanSchema,
  dcExecSchema,
  dcReviewSchema,
  dcApprovalSchema,
  dcEditSchema,
  dcSkipSchema,
  dcPollSchema,
  dcBudgetSchema,
  dcScoreSchema,
} from "./delegationSchemasRuntime.js";

export * from "./delegationSchemasRuntime.js";

export type Tier = z.infer<typeof tierSchema>;
export type Estimate = z.infer<typeof estimateSchema>;
export type DevPreviewKind = z.infer<typeof devPreviewKindSchema>;
export type Gate = z.infer<typeof gateSchema>;
export type DcGoalRow = z.infer<typeof dcGoalSchema>;
export type DcQuestionRow = z.infer<typeof dcQuestionSchema>;
export type DcForecastRow = z.infer<typeof dcForecastSchema>;
export type DcGoalApprovalRow = z.infer<typeof dcGoalApprovalSchema>;
export type DcPlanRow = z.infer<typeof dcPlanSchema>;
export type DcPreviewRow = z.infer<typeof dcPreviewSchema>;
export type DcGatesRow = z.infer<typeof dcGatesSchema>;
export type DcDevPreviewRow = z.infer<typeof dcDevPreviewSchema>;
export type DcProbeRow = z.infer<typeof dcProbeSchema>;
export type DcReplanRow = z.infer<typeof dcReplanSchema>;
export type DcExecRow = z.infer<typeof dcExecSchema>;
export type DcReviewRow = z.infer<typeof dcReviewSchema>;
export type DcApprovalRow = z.infer<typeof dcApprovalSchema>;
export type DcEditRow = z.infer<typeof dcEditSchema>;
export type DcSkipRow = z.infer<typeof dcSkipSchema>;
export type DcPollRow = z.infer<typeof dcPollSchema>;
export type DcBudgetRow = z.infer<typeof dcBudgetSchema>;
export type DcScoreRow = z.infer<typeof dcScoreSchema>;
