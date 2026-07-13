import type { ScenarioValue } from "../scenario/ast.ts";
export type TraceEvent = Readonly<{ readonly seq: number; readonly at: number; readonly type: "schedule" | "barrier" | "fault" | "task" | "effect" | "opaque-effect" | "capability" | "wait" | "ambiguity" | "adapter"; readonly id?: string; readonly data?: ScenarioValue }>;
