import React from "react";
import { DEFAULT_MERGE_QUEUE_CONCURRENCY, MERGE_QUEUE_PRIORITY } from "@smthrs/graph/constants";
/** @typedef {import("./MergeQueueProps.ts").MergeQueueProps} MergeQueueProps */

/**
 * @param {MergeQueueProps} props
 */
export function MergeQueue(props) {
  if (props.skipIf) return null;
  const next = {
    maxConcurrency: props.maxConcurrency ?? DEFAULT_MERGE_QUEUE_CONCURRENCY,
    // Landing work outranks starting new work by default: descendant task
    // nodes inherit this priority (an explicit child priority still wins).
    priority: props.priority ?? MERGE_QUEUE_PRIORITY,
    ...(props.failurePolicy === undefined ? {} : { failurePolicy: props.failurePolicy }),
    id: props.id,
  };
  return React.createElement("smithers:merge-queue", next, props.children);
}
