/// <reference path="../types/bun-test-shim.d.ts" />
import { FakeAgent, SafeSchema } from './fakeAgent.js';
import { AgentTraceVector } from './agentTraceVector.js';
import { VirtualClock } from './virtualClock.js';

/**
 * scriptedAgent — in-process AgentLike driven by an AgentTraceVector.
 * Uses a virtual clock for delays; emits onStdout text chunks for stream fidelity.
 */

type ScriptedAgentPacing = {
    /** Inclusive min wall/virtual delay before playing the turn stream (ms). */
    minMs: number;
    /** Inclusive max delay (ms). Random uniform in [minMs, maxMs]. */
    maxMs: number;
};
type ScriptedAgentOptions = {
    id?: string;
    model?: string;
    clock?: VirtualClock;
    /** Optional schema to validate ok.output (like fakeAgent). */
    schema?: SafeSchema<unknown>;
    supportsNativeStructuredOutput?: boolean;
    /**
     * Extra per-generate pacing so human herdr watch can see "working" and
     * streaming overview updates. Typical human watch: { minMs: 2000, maxMs: 5000 }
     * with a real wall clock.
     */
    pacing?: ScriptedAgentPacing;
};
type ScriptedAgent = FakeAgent<unknown> & {
    readonly vector: AgentTraceVector;
    readonly clock: VirtualClock;
    /** Indices of turns already consumed. */
    readonly usedTurnIndexes: ReadonlySet<number>;
};
/**
 * Build an AgentLike that plays {@link AgentTraceVector} turns in order
 * (with optional when-matching for steers / retries).
 */
declare function scriptedAgent(vector: AgentTraceVector, options?: ScriptedAgentOptions): ScriptedAgent;

export { type ScriptedAgent, type ScriptedAgentOptions, type ScriptedAgentPacing, scriptedAgent };
