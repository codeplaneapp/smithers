import { Effect } from "effect";
import type { OutputSnapshot } from "@smithers/driver/OutputSnapshot";
import { SmithersError } from "@smithers/errors/SmithersError";
export declare function loadOutputs(db: any, schema: Record<string, any>, runId: string): Effect.Effect<OutputSnapshot, SmithersError>;
