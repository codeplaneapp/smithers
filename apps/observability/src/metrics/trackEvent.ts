import { Effect } from "effect";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
export declare function trackEvent(event: SmithersEvent): Effect.Effect<void>;
