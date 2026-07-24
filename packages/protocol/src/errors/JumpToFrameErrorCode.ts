export type JumpToFrameErrorCode =
  | "InvalidRunId"
  | "InvalidFrameNo"
  | "RunNotFound"
  | "FrameOutOfRange"
  | "ConfirmationRequired"
  | "Busy"
  | "UnsupportedSandbox"
  | "VcsError"
  | "RewindFailed"
  | "TIME_TRAVEL_SIDE_EFFECT_BLOCKED"
  | "RateLimited"
  | "Unauthorized";
