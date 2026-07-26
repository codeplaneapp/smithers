// @smithers-type-exports-begin
/** @typedef {import("./SuperSmithersProps.ts").SuperSmithersProps} SuperSmithersProps */
// @smithers-type-exports-end

import React from "react";
import { renderPromptToText } from "./Task.js";
/**
 * SuperSmithers — a workflow wrapper that reads and modifies source code
 * to intervene via hot reload. Takes a markdown strategy doc and an agent
 * that decides what to change.
 *
 * Only meaningful in hot-reload mode: the agent reads source files, proposes
 * modifications, and (unless `dryRun` is set) writes them to disk, triggering
 * the hot reload system to pick up the changes.
 *
 * Internally expands to a sequence of tasks:
 * 1. Agent reads the strategy doc and target files
 * 2. (If not dryRun) Agent applies the modifications directly to disk
 * 3. A compute marker records the apply and triggers the hot-reload system
 * 4. Agent generates a report of what changed
 *
 * ```tsx
 * <SuperSmithers
 *   id="refactor"
 *   strategy={strategyMd}
 *   agent={codeAgent}
 *   targetFiles={["src/**\/*.ts"]}
 *   reportOutput={outputs.report}
 * />
 * ```
 * @param {SuperSmithersProps} props
 */
export function SuperSmithers(props) {
  const { id: idPrefix, strategy, agent, targetFiles, reportOutput, dryRun, skipIf } = props;
  if (skipIf) return null;
  const prefix = idPrefix ?? "super-smithers";
  // Task 1: Read strategy and target files
  const readTaskId = `${prefix}-read`;
  const readOutput = "super-smithers-read";
  const strategyText = typeof strategy === "string" ? strategy : undefined;
  const strategyElement = typeof strategy !== "string" ? strategy : undefined;
  const readPrompt = strategyText
    ? `You are a code intervention agent.\n\n## Strategy\n\n${strategyText}\n\n## Target Files\n\n${targetFiles?.length ? targetFiles.join(", ") : "All files in the project"}\n\nRead the target files and understand the codebase. Identify what changes are needed according to the strategy.`
    : undefined;
  // An element strategy must be flattened to text here: the raw
  // "smithers:task" host takes its prompt from String(children), so a live
  // React element would reach the agent as "[object Object]".
  const readChildren = strategyElement
    ? renderPromptToText(
        React.createElement(
          React.Fragment,
          null,
          strategyElement,
          React.createElement(
            "p",
            null,
            `Target files: ${targetFiles?.length ? targetFiles.join(", ") : "All files in the project"}`,
          ),
        ),
      )
    : readPrompt;
  const readTask = React.createElement(
    "smithers:task",
    {
      id: readTaskId,
      output: readOutput,
      agent,
      __smithersKind: "agent",
    },
    readChildren,
  );
  // Task 2: Apply the modifications (or, in a dry run, propose them only)
  const proposeTaskId = `${prefix}-propose`;
  const proposeOutput = "super-smithers-propose";
  const proposeTask = React.createElement(
    "smithers:task",
    {
      id: proposeTaskId,
      output: proposeOutput,
      agent,
      dependsOn: [readTaskId],
      __smithersKind: "agent",
    },
    dryRun
      ? "Based on your analysis, propose specific code modifications. This is a DRY RUN — do NOT modify any files. " +
          "For each file, provide the exact changes needed as a list of edits: the file path, the original code, and the replacement code."
      : "Based on your analysis, apply the necessary code modifications directly to the target files using your file-editing tools. " +
          "Make each edit on disk now. After applying them, list each file you changed with a short description of the change.",
  );
  // Task 3: Sync marker after the apply agent has written its edits (skipped on
  // dry runs). The edits themselves are made by the agent in Task 2; this compute
  // step is a dependency barrier so the report below only runs once the apply
  // task has settled (and its settled write triggers the hot-reload system).
  const applyTaskId = `${prefix}-apply`;
  const applyOutput = "super-smithers-apply";
  const applyTask = !dryRun
    ? React.createElement(
        "smithers:task",
        {
          id: applyTaskId,
          output: applyOutput,
          dependsOn: [proposeTaskId],
          __smithersKind: "compute",
          __smithersComputeFn: async () => {
            return { applied: true };
          },
        },
        null,
      )
    : null;
  // Task 4: Generate report
  const reportTaskId = `${prefix}-report`;
  const finalOutput = reportOutput ?? "super-smithers-report";
  const reportTask = React.createElement(
    "smithers:task",
    {
      id: reportTaskId,
      output: finalOutput,
      agent,
      dependsOn: dryRun ? [proposeTaskId] : [applyTaskId],
      __smithersKind: "agent",
    },
    `Generate a summary report of the intervention. ` +
      `Describe what was analyzed, what changes were ${dryRun ? "proposed (dry run)" : "applied"}, ` +
      `and any observations or warnings.`,
  );
  // Wrap all tasks in a sequence
  const sequenceChildren = [readTask, proposeTask];
  if (applyTask) sequenceChildren.push(applyTask);
  sequenceChildren.push(reportTask);
  return React.createElement("smithers:sequence", { id: prefix }, ...sequenceChildren);
}
