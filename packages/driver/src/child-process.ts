import { Effect } from "effect";
import { SmithersError } from "@smithers/errors/SmithersError";
export type SpawnCaptureOptions = {
    cwd: string;
    env?: Record<string, string | undefined>;
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    maxOutputBytes?: number;
    detached?: boolean;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
};
export type SpawnCaptureResult = {
    stdout: string;
    stderr: string;
    exitCode: number | null;
};
export declare function spawnCaptureEffect(command: string, args: string[], options: SpawnCaptureOptions): Effect.Effect<SpawnCaptureResult, SmithersError>;
