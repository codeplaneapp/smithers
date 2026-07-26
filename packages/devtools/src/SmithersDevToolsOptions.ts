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
   * Max number of runs the store retains before FIFO-evicting the oldest.
   * Default 500. Pass Infinity to disable eviction.
   */
  maxRunsRetained?: number;
  /**
   * Max events retained per run before FIFO-evicting the oldest events.
   * Default 10000. Pass Infinity to disable eviction.
   */
  maxEventsPerRun?: number;
  /**
   * Max task states retained per run before FIFO-evicting the oldest. One
   * state exists per `(nodeId, iteration)`, so a looping run grows this with
   * iterations, not node count. Default 5000. Pass Infinity to disable
   * eviction.
   */
  maxTasksPerRun?: number;
  /**
   * Max tool calls retained per task before FIFO-evicting the oldest. Status
   * updates still land on any retained call. Default 1000. Pass Infinity to
   * disable eviction.
   */
  maxToolCallsPerTask?: number;
};
