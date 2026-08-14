import * as ai from 'ai';
import * as _smithers_orchestrator_agents from '@smthrs/agents';

/**
 * Minimal structural types for elizaOS so this file compiles even when
 * @elizaos/core is not installed. We use `import type` only, so there is no
 * runtime dependency.
 */
/** Minimal elizaOS Character shape — structural, not imported from core. */
type ElizaCharacter$1 = {
    name: string;
    bio?: string | string[];
    lore?: string[];
    messageExamples?: unknown[];
    postExamples?: string[];
    topics?: string[];
    adjectives?: string[];
    knowledge?: string[];
    clients?: string[];
    plugins?: string[];
    settings?: Record<string, unknown>;
    system?: string;
    [key: string]: unknown;
};
/** Minimal elizaOS Plugin shape — structural, not imported from core. */
type ElizaPlugin$1 = {
    name: string;
    description?: string;
    actions?: unknown[];
    providers?: unknown[];
    evaluators?: unknown[];
    services?: unknown[];
    [key: string]: unknown;
};
/**
 * Options for {@link ElizaAgent}.
 *
 * Wraps the elizaOS `AgentRuntime` in-process, forwarding plugins/settings
 * so callers can use any elizaOS plugin (Slack, Discord, Telegram, etc.)
 * as a Smithers agent backend.
 */
type ElizaAgentOptions$2 = {
    /**
     * The elizaOS Character definition for this agent.
     * Passed directly to `AgentRuntime` — any elizaOS-compatible character
     * object is accepted.
     */
    character: ElizaCharacter$1;
    /**
     * elizaOS plugins to register on the runtime (Services, Actions,
     * Providers, Evaluators). This is how callers bolt on Slack/Discord/etc.
     */
    plugins?: ElizaPlugin$1[];
    /**
     * Key-value settings forwarded to the runtime (e.g. `SLACK_BOT_TOKEN`).
     * Merged with the character's existing `settings` record.
     */
    settings?: Record<string, string>;
    /**
     * Additional environment variables forwarded to the runtime alongside
     * `settings`. Merged in when constructing the runtime.
     */
    env?: Record<string, string>;
    /**
     * Optional model label used in result diagnostics and the `modelId` field
     * of `buildGenerateResult`. Defaults to `"eliza"`.
     */
    model?: string;
    /**
     * Alias for `model` — either may be used; `model` takes precedence.
     */
    modelId?: string;
    /**
     * Optional unique identifier for this agent instance.
     */
    id?: string;
};

/**
 * Smithers agent harness that wraps an elizaOS `AgentRuntime` in-process.
 *
 * Callers pass a `character` and any elizaOS `plugins` they need (Slack,
 * Discord, Telegram, model-provider plugins, etc.). The harness lazily
 * initializes the runtime on the first `generate` call and memoizes it
 * across subsequent calls.
 *
 * `@elizaos/core` is a hard dependency this opt-in package owns and installs.
 * It is resolved via a dynamic import (so this module carries no load-time
 * dependency and the structural types keep the build self-contained), but
 * consumers of `@smthrs/agent-eliza` get it transitively.
 */
declare class ElizaAgent {
    /**
     * @param {ElizaAgentOptions} opts
     * @param {{ runtimeFactory?: ElizaRuntimeFactory }} [_internal]
     *   Internal seam for tests — pass a fake runtime factory to avoid
     *   requiring @elizaos/core during tests.
     */
    constructor(opts: ElizaAgentOptions$1, _internal?: {
        runtimeFactory?: ElizaRuntimeFactory;
    });
    /** @type {string | undefined} */
    id: string | undefined;
    /** @type {boolean} */
    supportsNativeStructuredOutput: boolean;
    /**
     * Deterministically verify that @elizaos/core can be resolved and that
     * the configured character is minimally coherent. A rejected promise
     * fails the task without retry — that is the intended behavior.
     *
     * @param {AgentGenerateOptions} [_args]
     * @returns {Promise<void>}
     */
    preflight(_args?: AgentGenerateOptions): Promise<void>;
    /**
     * Generate a response from the elizaOS runtime.
     *
     * @param {AgentGenerateOptions} [args]
     * @returns {Promise<GenerateTextResult<Record<string, never>, unknown>>}
     */
    generate(args?: AgentGenerateOptions): Promise<GenerateTextResult<Record<string, never>, unknown>>;
    /**
     * Gracefully stop the runtime and release any held resources.
     * Safe to call before init or while init is in progress.
     *
     * @returns {Promise<void>}
     */
    stop(): Promise<void>;
    #private;
}
type ElizaAgentOptions$1 = ElizaAgentOptions$2;
type AgentGenerateOptions = _smithers_orchestrator_agents.AgentGenerateOptions;
type GenerateTextResult = ai.GenerateTextResult<any, any>;
/**
 * Internal interface for the elizaOS AgentRuntime — structural only, so we
 * don't hard-depend on
 */
type ElizaRuntime = {
    initialize(): Promise<void>;
    useModel(modelType: string, params: {
        prompt: string;
        stopSequences?: string[];
        abortSignal?: AbortSignal;
    }): Promise<string>;
    stop?(): Promise<void>;
};
/**
 * Factory that constructs an ElizaRuntime. Injected for testing.
 */
type ElizaRuntimeFactory = (opts: ElizaAgentOptions$1) => Promise<ElizaRuntime>;

type ElizaAgentOptions = ElizaAgentOptions$2;
type ElizaCharacter = ElizaCharacter$1;
type ElizaPlugin = ElizaPlugin$1;

export { ElizaAgent, type ElizaAgentOptions, type ElizaCharacter, type ElizaPlugin };
