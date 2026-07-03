import type { DevToolsEngineEvent } from "./DevToolsEngineEvent.ts";
import type { DevToolsEventHandler } from "./DevToolsEventHandler.ts";

export type SmithersDevToolsOptions = {
  /** Called on every renderer commit that touches the Smithers tree */
  onCommit?: DevToolsEventHandler;
  /** Called on every SmithersEvent from an attached EventBus */
  onEngineEvent?: (event: DevToolsEngineEvent) => void;
  /** Enable verbose console logging */
  verbose?: boolean;
  /**
   * Max runs retained in the in-memory store before the oldest are evicted
   * (terminal runs first). On a long-lived bus the store would otherwise grow
   * without bound. Defaults to 500; set 0 or a negative value to disable.
   */
  maxRuns?: number;
  /**
   * Max engine events retained per run before the oldest are dropped. A hot run
   * can emit unbounded events; this caps per-run memory. Defaults to 10000; set
   * 0 or a negative value to disable.
   */
  maxEventsPerRun?: number;
};
