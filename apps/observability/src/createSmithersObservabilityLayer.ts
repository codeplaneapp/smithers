import * as BunContext from "@effect/platform-bun/BunContext";
import { Layer } from "effect";
import { SmithersObservability } from "./SmithersObservability";
import type { SmithersObservabilityOptions } from "./SmithersObservabilityOptions";
export declare function createSmithersObservabilityLayer(options?: SmithersObservabilityOptions): Layer.Layer<import("./_coreMetrics").MetricsService | import("./_coreTracing").TracingService | SmithersObservability | BunContext.BunContext, never, never>;
