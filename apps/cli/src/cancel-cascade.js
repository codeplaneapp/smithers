// Thin CLI-facing alias for the shared subtree-cancellation operation.
//
// The implementation lives in `@smthrs/engine/cancel-subtree` so that
// `smithers cancel`, `smithers down`, and the gateway's public HTTP/RPC
// `cancelRun` all drive the SAME transactional recursive cancellation with one
// claim/termination policy (#971, #972). Only the historical CLI export name
// (`cascadeCancelRun`) is kept here.

export {
  cancelRunSubtree,
  cancelRunSubtree as cascadeCancelRun,
  finalizeCancelledOwnedRun,
  isCancellableRunStatus,
  listCascadeLineage,
  terminateRunOwner,
  terminateSubtreeAgentProcesses,
} from "@smthrs/engine/cancel-subtree";
