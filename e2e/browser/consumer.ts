import React from "react";
import {
  createBrowserRuntime,
  createBrowserSmithers,
  defineBrowserWorkflow,
  Task,
  Workflow,
  type BrowserWorkflow,
  type RuntimeAdapter,
} from "smithers-orchestrator/browser";
import { assertCapabilityError } from "@smithers-orchestrator/testing/browser";

const runtime: RuntimeAdapter = createBrowserRuntime();
const workflow: BrowserWorkflow = defineBrowserWorkflow((ctx) =>
  React.createElement(
    Workflow,
    { name: "typed" },
    React.createElement(Task, { id: "typed", output: "typed" }, String(ctx.input ?? "")),
  ),
);
const smithers = createBrowserSmithers({ workflow, runtime });
assertCapabilityError("worktree", "resolve", () => runtime.worktree.resolve("./lane"));
void smithers;
