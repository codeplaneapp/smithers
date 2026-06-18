export type ReasonBlocked =
  | { kind: "approval"; nodeId: string; requestedAt: string }
  | { kind: "event"; nodeId: string; correlationKey: string }
  | { kind: "timer"; nodeId: string; wakeAt: string }
  | { kind: "approval-decided-resume-required"; nodeId: string }
  | { kind: "external-trigger" }
  | {
      kind: "provider";
      nodeId: string;
      code: "rate-limit" | "auth" | "timeout";
    }
  | { kind: "tool"; nodeId: string; toolName: string; code: string };
