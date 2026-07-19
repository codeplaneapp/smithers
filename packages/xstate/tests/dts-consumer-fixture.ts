import { createMachine } from "xstate";
import { z } from "zod";
import {
  approvalDecided,
  eventReceived,
  taskOutput,
  timedOut,
  useSmithersMachine,
  type SmithersEventSource,
} from "@smithers-orchestrator/xstate";

const machine = createMachine({
  context: { revision: 0 },
  initial: "awaiting",
  states: { awaiting: { on: { APPROVED: "shipped" } }, shipped: { type: "final" } },
});

const reviseSchema = z.object({ feedback: z.string() });

const sources: SmithersEventSource[] = [
  taskOutput<{ title: string }>("report", { nodeId: "research" }, (payload, meta) => {
    payload.title satisfies string;
    meta.seq satisfies number;
    meta.nodeId satisfies string;
    meta.iteration satisfies number;
    return { type: "RESEARCH_DONE" };
  }),
  approvalDecided<{ approved: boolean }>("gate", { nodeId: "gate" }, (decision) =>
    decision.approved ? { type: "APPROVED" } : [{ type: "REJECTED" }, { type: "LOG" }],
  ),
  eventReceived("REVISE", reviseSchema, { correlationId: "subflow-a" }, (payload, meta) => {
    meta.signalName satisfies string;
    meta.seq satisfies number;
    meta.receivedAtMs satisfies number;
    meta.correlationId satisfies string | undefined;
    return { type: "REVISE", feedback: (payload as z.infer<typeof reviseSchema>).feedback };
  }),
  timedOut("reviseWait", { scope: "revise" }, (payload) => {
    payload.kind satisfies "timeout";
    return null;
  }),
];

declare function renderProbe(): void;
export function Component() {
  const state = useSmithersMachine(machine, { id: "release", input: { topic: "x" }, events: sources });
  // The returned MachineSnapshot keeps its API surface through the emitted .d.ts.
  state.matches("awaiting") satisfies boolean;
  state.can({ type: "APPROVED" }) satisfies boolean;
  state.hasTag("t") satisfies boolean;
  state.context satisfies { revision: number };
  state.status satisfies "active" | "done" | "error" | "stopped";
  // @ts-expect-error snapshot status is a closed union, not arbitrary strings
  state.status satisfies "banana";
  renderProbe();
  return null;
}
