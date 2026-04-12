import { Effect } from "effect";
/**
 * Walk up from `startDir` to find the nearest directory containing `.jj` or `.git`.
 * Prefers `.jj` over `.git` so colocated repos (both exist) use jj semantics.
 * Returns the VCS type and root path, or null if neither is found.
 */
export declare function findVcsRoot(startDir: string): Effect.Effect<{
    type: "jj";
    root: string;
} | {
    type: "git";
    root: string;
} | null, never, never>;
