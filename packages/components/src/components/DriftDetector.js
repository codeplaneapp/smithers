import React from "react";
import { SmithersContext } from "@smthrs/react-reconciler/context";
import { Task } from "./Task.js";
import { Sequence } from "./Sequence.js";
import { Branch } from "./Branch.js";
import { Loop } from "./Ralph.js";
/** @typedef {import("./DriftDetectorProps.ts").DriftDetectorProps} DriftDetectorProps */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} comparison
 * @param {((comparison: unknown) => boolean) | undefined} alertIf
 * @returns {boolean}
 */
function shouldAlert(comparison, alertIf) {
  if (comparison == null) {
    return false;
  }
  if (alertIf) {
    return Boolean(alertIf(comparison));
  }
  return isRecord(comparison) && comparison.drifted === true;
}

/**
 * @param {DriftDetectorProps} props
 */
export function DriftDetector(props) {
  if (props.skipIf) return null;
  const prefix = props.id ?? "drift";
  const ctx = React.useContext(SmithersContext);
  const comparison = ctx?.outputMaybe(props.compareOutput, { nodeId: `${prefix}-compare` });
  const drifted = shouldAlert(comparison, props.alertIf);
  const captureTask = React.createElement(Task, {
    id: `${prefix}-capture`,
    output: props.captureOutput,
    agent: props.captureAgent,
    children: `Capture the current state for drift detection. Baseline reference: ${
      typeof props.baseline === "string" ? props.baseline : JSON.stringify(props.baseline)
    }`,
  });
  const compareTask = React.createElement(Task, {
    id: `${prefix}-compare`,
    output: props.compareOutput,
    agent: props.compareAgent,
    dependsOn: [`${prefix}-capture`],
    children: `Compare the captured current state against the baseline and determine if meaningful drift has occurred. Include a "drifted" boolean and "significance" string in your response. Baseline: ${
      typeof props.baseline === "string" ? props.baseline : JSON.stringify(props.baseline)
    }`,
  });
  const alertBranch = props.alert
    ? React.createElement(Branch, {
        if: drifted,
        then: props.alert,
      })
    : null;
  const sequenceChildren = [captureTask, compareTask];
  if (alertBranch) sequenceChildren.push(alertBranch);
  const sequence = React.createElement(Sequence, null, ...sequenceChildren);
  if (props.poll) {
    const maxPolls = props.poll.maxPolls ?? 100;
    if (!Number.isFinite(maxPolls)) {
      throw new TypeError("DriftDetector poll.maxPolls must be a finite number.");
    }
    return React.createElement(
      Loop,
      {
        id: `${prefix}-poll`,
        until: false,
        maxIterations: maxPolls,
        onMaxReached: "return-last",
      },
      sequence,
    );
  }
  return sequence;
}
