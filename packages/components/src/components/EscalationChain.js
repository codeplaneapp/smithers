// @smithers-type-exports-begin
/** @typedef {import("./EscalationChainProps.ts").EscalationChainProps} EscalationChainProps */
/** @typedef {import("./EscalationLevel.ts").EscalationLevel} EscalationLevel */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { Sequence } from "./Sequence.js";
import { Branch } from "./Branch.js";
import { Task } from "./Task.js";
import { Approval } from "./Approval.js";
/**
 * Default escalation predicate: escalate when the previous level has no result
 * yet, or its result signals a failure (`error`/`failed` truthy or `ok === false`).
 * @param {unknown} result
 * @returns {boolean}
 */
function defaultEscalateIf(result) {
    if (result == null)
        return true;
    if (typeof result === "object") {
        const row = /** @type {Record<string, unknown>} */ (result);
        if (row.error != null && row.error !== false)
            return true;
        if (row.failed === true)
            return true;
        if (row.ok === false)
            return true;
    }
    return false;
}
/**
 * Resolve whether the previous level escalated by invoking its `escalateIf`
 * predicate (or the default) against its actual result.
 * @param {EscalationLevel} prevLevel
 * @param {unknown} prevResult
 * @returns {boolean}
 */
function didEscalate(prevLevel, prevResult) {
    const predicate = prevLevel.escalateIf ?? defaultEscalateIf;
    return Boolean(predicate(prevResult));
}
/**
 * Escalation chain: tries agents in order, escalating on failure or when
 * `escalateIf` returns `true`. Optionally ends with a human approval fallback.
 *
 * Composes Sequence + Task (with `continueOnFail`) + Branch + Approval.
 * @param {EscalationChainProps} props
 */
export function EscalationChain(props) {
    if (props.skipIf)
        return null;
    const ctx = React.useContext(SmithersContext);
    const prefix = props.id ?? "escalation";
    const { levels, children, humanFallback, humanRequest, escalationOutput } = props;
    // Build the chain from the last level forward, nesting each level inside a
    // Branch that gates on the previous level's escalation condition.
    // We construct the elements bottom-up so the final element is a single
    // Sequence that evaluates top-down at runtime.
    const levelElements = [];
    for (let i = 0; i < levels.length; i++) {
        const level = levels[i];
        const levelId = `${prefix}-level-${i}`;
        const isFirst = i === 0;
        const taskEl = React.createElement(Task, {
            id: levelId,
            output: level.output,
            agent: level.agent,
            continueOnFail: true,
            label: level.label ?? `Escalation level ${i}`,
            children: children,
        });
        if (isFirst) {
            // First level always runs.
            levelElements.push(taskEl);
        }
        else {
            // Subsequent levels are gated by a Branch that checks whether the
            // previous level needs escalation. The chain re-renders reactively as
            // outputs become available, so we read the previous level's actual
            // result from the workflow context and run its `escalateIf` predicate
            // (or the default failure predicate) to decide whether this level runs.
            const prevLevel = levels[i - 1];
            const prevLevelId = `${prefix}-level-${i - 1}`;
            const prevResult = ctx?.outputMaybe(prevLevel.output, { nodeId: prevLevelId });
            const escalated = didEscalate(prevLevel, prevResult);
            const checkId = `${prefix}-check-${i - 1}`;
            const checkTask = React.createElement(Task, {
                id: checkId,
                output: escalationOutput,
                continueOnFail: true,
                label: `Check escalation from level ${i - 1}`,
                children: () => {
                    // Record the escalation decision for the prior level so it is
                    // visible in the escalation output stream.
                    return {
                        escalated,
                        fromLevel: i - 1,
                        toLevel: i,
                    };
                },
            });
            // Gate the current level on the previous level's escalation decision:
            // it only mounts when the prior level actually escalated.
            const gatedLevel = React.createElement(Branch, {
                if: escalated,
                then: taskEl,
            });
            levelElements.push(checkTask);
            levelElements.push(gatedLevel);
        }
    }
    // Append human fallback if requested. It only mounts when every automated
    // level escalated (i.e. all automated levels were exhausted). A single
    // level resolving without escalation stops the chain and the fallback, even
    // if later levels never ran and therefore have no recorded result.
    if (humanFallback && levels.length > 0) {
        const humanId = `${prefix}-human-fallback`;
        const request = humanRequest ?? {
            title: "Escalation requires human review",
            summary: `All ${levels.length} automated levels have been exhausted.`,
        };
        const allEscalated = levels.every((level, idx) => {
            const levelResult = ctx?.outputMaybe(level.output, {
                nodeId: `${prefix}-level-${idx}`,
            });
            return didEscalate(level, levelResult);
        });
        const approvalEl = React.createElement(Approval, {
            id: humanId,
            output: escalationOutput,
            request,
            continueOnFail: true,
            label: request.title,
        });
        levelElements.push(React.createElement(Branch, {
            if: allEscalated,
            then: approvalEl,
        }));
    }
    return React.createElement(Sequence, {}, ...levelElements);
}
