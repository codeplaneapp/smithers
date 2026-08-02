import type { SmithersDb } from "@smthrs/db/adapter";
import type { SmithersEvent } from "@smthrs/observability/SmithersEvent";
import type { JumpStepName } from "./JumpStepName";

export type JumpToFrameInput = {
  adapter: SmithersDb;
  runId: unknown;
  frameNo: unknown;
  confirm?: unknown;
  caller?: string;
  /** Bypass the live-run guard (rewind a run that still looks actively driven). */
  force?: unknown;
  /** Skip registered compensation handlers; crossed effects then require force. */
  noRevert?: unknown;
  pauseRunLoop?: () => Promise<void> | void;
  resumeRunLoop?: () => Promise<void> | void;
  captureReconcilerState?: () => Promise<unknown> | unknown;
  restoreReconcilerState?: (snapshot: unknown) => Promise<void> | void;
  rebuildReconcilerState?: (xmlJson: string) => Promise<void> | void;
  emitEvent?: (event: SmithersEvent) => Promise<void> | void;
  getCurrentPointerImpl?: (cwd?: string) => Promise<string | null>;
  revertToPointerImpl?: (pointer: string, cwd?: string) => Promise<{ success: boolean; error?: string }>;
  nowMs?: () => number;
  rateLimit?: {
    maxPerWindow?: number;
    windowMs?: number;
  };
  hooks?: {
    beforeStep?: (step: JumpStepName) => Promise<void> | void;
    afterStep?: (step: JumpStepName) => Promise<void> | void;
  };
  onLog?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => Promise<void> | void;
};
