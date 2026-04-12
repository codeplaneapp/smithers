import { Effect } from "effect";
import { SmithersError } from "@smithers/errors/SmithersError";
export declare function loadInput(db: any, inputTable: any, runId: string): Effect.Effect<any, SmithersError>;
