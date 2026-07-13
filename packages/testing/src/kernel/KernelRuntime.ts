import { Context, Effect, Fiber, Layer } from "effect";
import type { ControlMessage } from "../control/ControlMessage.ts";
import { ControlBus } from "./ControlBus.ts";
import { SeededScheduler } from "./SeededScheduler.ts";
import { TraceCollector } from "./TraceCollector.ts";
import { VirtualClock } from "./VirtualClock.ts";
export type KernelRuntime = Readonly<{ readonly clock: VirtualClock; readonly scheduler: SeededScheduler; readonly controls: ControlBus; readonly trace: TraceCollector }>;
export type KernelReadyTask = Readonly<{ readonly stepId: string; readonly effect: Effect.Effect<unknown, unknown> }>;
export type KernelExecutor = Readonly<{ readonly runReadySet: (tasks: readonly KernelReadyTask[]) => Effect.Effect<Readonly<{ readonly stepId: string; readonly value: unknown }>, unknown> }>;
export class KernelRuntimeService extends Context.Tag("@smithers/testing/KernelRuntime")<KernelRuntimeService, KernelRuntime & { readonly executor: KernelExecutor }>() {}
export const kernelLayer = (kernel: KernelRuntime & { readonly executor: KernelExecutor }): Layer.Layer<KernelRuntimeService> => Layer.succeed(KernelRuntimeService, kernel);
export const makeKernel = (seed: number, controls: readonly ControlMessage[] = []): KernelRuntime & { readonly executor: KernelExecutor } => {
  const clock = new VirtualClock(); const bus = new ControlBus(controls); const runtime = { clock, scheduler: new SeededScheduler(seed), controls: bus, trace: new TraceCollector(clock) };
  const active = new Map<string, Fiber.Fiber<unknown, unknown>>();
  const executor: KernelExecutor = Object.freeze({
    // This is the kernel's scheduling boundary. Ready tasks are Effect values,
    // forked and raced by the Effect runtime; the public runner never owns the
    // task fibers or implements a Promise race itself.
    runReadySet: (tasks) => Effect.gen(function* () {
      for (const { stepId, effect } of tasks) if (!active.has(stepId)) active.set(stepId, yield* Effect.fork(effect));
      const winner = yield* Effect.raceAll([...active.entries()].map(([stepId, fiber]) => Fiber.join(fiber).pipe(Effect.map((value) => ({ stepId, value })))));
      active.delete(winner.stepId);
      return winner;
    }),
  });
  return Object.freeze({ ...runtime, executor });
};
export const kernelEffect = <A>(run: (kernel: KernelRuntime) => A): Effect.Effect<A> => Effect.sync(() => run(makeKernel(0)));
