import type { ScenarioValue } from "../scenario/ast.ts";
export type ControlMessage = Readonly<
  | { readonly type: "advance-clock"; readonly ms: number }
  | { readonly type: "timer-fire"; readonly timer: string }
  | { readonly type: "release-barrier"; readonly barrier: string }
  | { readonly type: "pin-interleaving"; readonly choice: string }
  | { readonly type: "inject-fault"; readonly fault: string; readonly payload?: ScenarioValue }
  | {
      readonly type: "resolve-effect";
      readonly effect: string;
      readonly outcome: "succeed" | "fail" | "hang" | "duplicate";
      readonly value?: ScenarioValue;
    }
  | { readonly type: "cancel"; readonly reason?: string }
  | { readonly type: "task-restart"; readonly step: string }
>;
