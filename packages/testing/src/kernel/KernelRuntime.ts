import { Context, Effect, Layer } from "effect";
import type { ControlMessage } from "../control/ControlMessage.ts";
import { ControlBus } from "./ControlBus.ts";
import { SeededScheduler } from "./SeededScheduler.ts";
import { TraceCollector } from "./TraceCollector.ts";
import { VirtualClock } from "./VirtualClock.ts";
export type KernelRuntime = Readonly<{ readonly clock: VirtualClock; readonly scheduler: SeededScheduler; readonly controls: ControlBus; readonly trace: TraceCollector }>;
export class KernelRuntimeService extends Context.Tag("@smithers/testing/KernelRuntime")<KernelRuntimeService, KernelRuntime>() {}
export const kernelLayer = (kernel: KernelRuntime): Layer.Layer<KernelRuntimeService> => Layer.succeed(KernelRuntimeService, kernel);
export const makeKernel = (seed: number, controls: readonly ControlMessage[] = []): KernelRuntime => { const clock = new VirtualClock(); const bus = new ControlBus(controls); return Object.freeze({ clock, scheduler: new SeededScheduler(seed), controls: bus, trace: new TraceCollector(clock) }); };
export const kernelEffect = <A>(run: (kernel: KernelRuntime) => A): Effect.Effect<A> => Effect.sync(() => run(makeKernel(0)));
