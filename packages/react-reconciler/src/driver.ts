import type React from "react";
import {
  WorkflowDriver,
  type WorkflowDriverOptions,
} from "@smithers/driver";
import { SmithersRenderer } from "./reconciler.ts";

export type SmithersWorkflowDriverOptions<Schema = unknown> =
  WorkflowDriverOptions<Schema, React.ReactElement>;

export class ReactWorkflowDriver<Schema = unknown> extends WorkflowDriver<
  Schema,
  React.ReactElement
> {
  constructor(options: SmithersWorkflowDriverOptions<Schema>) {
    const renderer = options.renderer ?? new SmithersRenderer();
    super({
      ...(options as Omit<
        WorkflowDriverOptions<Schema, React.ReactElement>,
        "renderer"
      >),
      renderer,
    });
  }
}
