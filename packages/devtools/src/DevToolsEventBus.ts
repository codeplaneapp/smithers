import type { DevToolsEngineEvent } from "./DevToolsEngineEvent.ts";

export type DevToolsEventBus = {
  on: (event: "event", handler: (e: DevToolsEngineEvent) => void) => void;
  removeListener: (
    event: "event",
    handler: (e: DevToolsEngineEvent) => void,
  ) => void;
};
