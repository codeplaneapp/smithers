/**
 * Event types that can change what the Claude /workflows mirror renders.
 * Tool-call, heartbeat, token-usage, and agent chatter events are excluded so
 * a blocking `smithers claude tick --wait` does not wake per tool call.
 */
export const claudeMirrorRelevantEventTypes = new Set([
  "FrameCommitted",
  "NodePending",
  "NodeStarted",
  "NodeFinished",
  "NodeFailed",
  "NodeCancelled",
  "NodeSkipped",
  "NodeRetrying",
  "NodeWaitingApproval",
  "NodeWaitingTimer",
  "ApprovalRequested",
  "ApprovalGranted",
  "ApprovalAutoApproved",
  "ApprovalDenied",
  "RunStarted",
  "RunStatusChanged",
  "RunFinished",
  "RunFailed",
  "RunCancelled",
  "RunContinuedAsNew",
]);
