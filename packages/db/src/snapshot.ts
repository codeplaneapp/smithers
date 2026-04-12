import { Effect } from "effect";
import type { OutputSnapshot } from "@smithers/driver/OutputSnapshot";
import { SmithersError } from "@smithers/errors/SmithersError";
export declare function loadInputEffect(db: any, inputTable: any, runId: string): Effect.Effect<any, SmithersError>;
export declare function loadInput(db: any, inputTable: any, runId: string): Promise<any>;
export declare function loadOutputsEffect(db: any, schema: Record<string, any>, runId: string): Effect.Effect<OutputSnapshot, SmithersError>;
export declare function loadOutputs(db: any, schema: Record<string, any>, runId: string): Promise<OutputSnapshot>;
