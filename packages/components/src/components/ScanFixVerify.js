import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { Task } from "./Task.js";
import { Sequence } from "./Sequence.js";
import { Parallel } from "./Parallel.js";
import { Loop } from "./Ralph.js";
/** @typedef {import("./ScanFixVerifyProps.ts").ScanFixVerifyProps} ScanFixVerifyProps */

/**
 * @param {ScanFixVerifyProps} props
 */
export function ScanFixVerify(props) {
    if (props.skipIf)
        return null;
    const prefix = props.id ?? "sfv";
    const maxRetries = props.maxRetries ?? 3;
    const ctx = React.useContext(SmithersContext);
    const loopId = `${prefix}-loop`;
    const iteration = ctx?.iterations?.[loopId] ?? ctx?.iteration ?? 0;
    const scanRow = ctx?.outputMaybe(props.scanOutput, {
        nodeId: `${prefix}-scan`,
        iteration,
    });
    const scanComplete = scanRow !== undefined;
    const issues = Array.isArray(scanRow?.issues) ? scanRow.issues : [];
    if (Array.isArray(props.fixer) && props.fixer.length === 0) {
        throw new TypeError("ScanFixVerify fixer array must contain at least one agent.");
    }
    const fixerForIssue = (index) => {
        if (!Array.isArray(props.fixer)) {
            return props.fixer;
        }
        if (props.fixer.length === 1) {
            return props.fixer[0];
        }
        const start = index % props.fixer.length;
        return [...props.fixer.slice(start), ...props.fixer.slice(0, start)];
    };
    // The scan task finds problems
    const scanTask = React.createElement(Task, {
        id: `${prefix}-scan`,
        output: props.scanOutput,
        agent: props.scanner,
        children: props.children ?? "Scan for problems and return an issues array.",
    });
    // The first render keeps the historical placeholder. Once the scan row
    // exists, the reactive re-render replaces it with one fix task per issue.
    const fixTaskIds = scanComplete
        ? issues.map((_, index) => `${prefix}-fix-${index}`)
        : [`${prefix}-fix`];
    const fixTasks = scanComplete
        ? issues.map((issue, index) => React.createElement(Task, {
            key: `${prefix}-fix-${index}`,
            id: `${prefix}-fix-${index}`,
            output: props.fixOutput,
            agent: fixerForIssue(index),
            dependsOn: [`${prefix}-scan`],
            children: `Fix scan issue ${index + 1} of ${issues.length}: ${typeof issue === "string" ? issue : JSON.stringify(issue)}`,
        }))
        : [
            React.createElement(Task, {
                id: `${prefix}-fix`,
                output: props.fixOutput,
                agent: props.fixer,
                dependsOn: [`${prefix}-scan`],
                children: "Fix all issues identified by the scan. Address each problem found.",
            }),
        ];
    const fixParallel = React.createElement(Parallel, { id: `${prefix}-fixes`, maxConcurrency: props.maxConcurrency }, ...fixTasks);
    // Verify that all fixes were applied correctly
    const verifyTask = React.createElement(Task, {
        id: `${prefix}-verify`,
        output: props.verifyOutput,
        agent: props.verifier,
        dependsOn: scanComplete && fixTaskIds.length === 0 ? [`${prefix}-scan`] : fixTaskIds,
        children: "Verify that all fixes were applied correctly. Return whether all issues are resolved.",
    });
    // The inner loop: scan → fix → verify, repeating until verification passes
    const innerSequence = React.createElement(Sequence, null, scanTask, fixParallel, verifyTask);
    const loop = React.createElement(Loop, {
        id: loopId,
        until: false, // Re-evaluated at render time via reactive context
        maxIterations: maxRetries,
        onMaxReached: "return-last",
    }, innerSequence);
    // Final report task after the loop completes
    const reportTask = React.createElement(Task, {
        id: `${prefix}-report`,
        output: props.reportOutput,
        agent: props.verifier,
        dependsOn: [`${prefix}-verify`],
        children: "Produce a final summary report of all scan-fix-verify cycles, including what was found, what was fixed, and the final verification status.",
    });
    return React.createElement(Sequence, null, loop, reportTask);
}
