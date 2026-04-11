import type React from "react";
import type {
  Workflow,
  WorkflowDriverOptions,
} from "@smithers/core";

export type SmithersWorkflow<Schema = unknown> = Workflow<
  Schema,
  React.ReactElement
>;

export type SmithersWorkflowDriverOptions<Schema = unknown> =
  WorkflowDriverOptions<Schema, React.ReactElement>;

export type * from "@smithers/core/workflow-types";
