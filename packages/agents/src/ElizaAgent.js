import { buildGenerateResult } from "./BaseCliAgent/buildGenerateResult.js";

/** @typedef {import("./ElizaAgentOptions.ts").ElizaAgentOptions} ElizaAgentOptions */
/** @typedef {import("./ElizaAgentOptions.ts").ElizaPlugin} ElizaPlugin */
/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */

/**
 * Internal interface for the elizaOS AgentRuntime — structural only, so we
 * don't hard-depend on @elizaos/core at module load time.
 * @typedef {{
 *   initialize(): Promise<void>;
 *   useModel(modelType: string, params: { prompt: string; stopSequences?: string[] }): Promise<string>;
 *   stop?(): Promise<void>;
 * }} ElizaRuntime
 */

/**
 * Factory that constructs an ElizaRuntime. Injected for testing.
 * @typedef {(opts: ElizaAgentOptions) => Promise<ElizaRuntime>} ElizaRuntimeFactory
 */

/**
 * Default factory: dynamically imports @elizaos/core and builds an
 * AgentRuntime from the provided options.
 *
 * @param {ElizaAgentOptions} opts
 * @returns {Promise<ElizaRuntime>}
 */
async function defaultRuntimeFactory(opts) {
    let core;
    try {
        core = await import("@elizaos/core");
    } catch {
        throw new Error(
            "install @elizaos/core to use ElizaAgent: npm install @elizaos/core"
        );
    }

    const AgentRuntime = core.AgentRuntime ?? core.default?.AgentRuntime;
    if (!AgentRuntime) {
        throw new Error(
            "@elizaos/core loaded but AgentRuntime was not found. " +
            "Ensure @elizaos/core@~1.7.2 is installed."
        );
    }

    const mergedSettings = {
        ...(opts.character.settings ?? {}),
        ...(opts.settings ?? {}),
        ...(opts.env ?? {}),
    };

    const runtime = new AgentRuntime({
        character: {
            ...opts.character,
            settings: mergedSettings,
        },
        plugins: opts.plugins ?? [],
    });

    return runtime;
}

/**
 * Smithers agent harness that wraps an elizaOS `AgentRuntime` in-process.
 *
 * Callers pass a `character` and any elizaOS `plugins` they need (Slack,
 * Discord, Telegram, model-provider plugins, etc.). The harness lazily
 * initializes the runtime on the first `generate` call and memoizes it
 * across subsequent calls.
 *
 * `@elizaos/core` is an **optional peer dependency** — it is resolved via
 * a dynamic import so the package builds and tests without it installed.
 */
export class ElizaAgent {
    /** @type {string | undefined} */
    id;
    /** @type {boolean} */
    supportsNativeStructuredOutput = false;

    /** @type {ElizaAgentOptions} */
    #opts;
    /** @type {string} */
    #modelId;
    /** @type {ElizaRuntime | null} */
    #runtime = null;
    /** @type {Promise<ElizaRuntime> | null} */
    #initPromise = null;
    /** @type {ElizaRuntimeFactory} */
    #runtimeFactory;

    /**
     * @param {ElizaAgentOptions} opts
     * @param {{ runtimeFactory?: ElizaRuntimeFactory }} [_internal]
     *   Internal seam for tests — pass a fake runtime factory to avoid
     *   requiring @elizaos/core during tests.
     */
    constructor(opts, _internal = {}) {
        this.#opts = opts;
        this.#modelId = opts.model ?? opts.modelId ?? "eliza";
        this.id = opts.id;
        this.#runtimeFactory = _internal.runtimeFactory ?? defaultRuntimeFactory;
    }

    /**
     * Deterministically verify that @elizaos/core can be resolved and that
     * the configured character is minimally coherent. A rejected promise
     * fails the task without retry — that is the intended behavior.
     *
     * @param {AgentGenerateOptions} [_args]
     * @returns {Promise<void>}
     */
    async preflight(_args) {
        if (!this.#opts.character?.name) {
            throw new Error(
                "ElizaAgent: character.name is required. " +
                "Provide a valid elizaOS Character with at least a name."
            );
        }
        // Attempt to construct the runtime (resolves @elizaos/core) so we
        // surface missing-dep errors at preflight time rather than at generate.
        await this.#ensureRuntime();
    }

    /**
     * Lazily construct + initialize the AgentRuntime exactly once.
     * Guards against concurrent initialization.
     *
     * @returns {Promise<ElizaRuntime>}
     */
    async #ensureRuntime() {
        if (this.#runtime) return this.#runtime;
        if (this.#initPromise) return this.#initPromise;

        this.#initPromise = this.#runtimeFactory(this.#opts).then(
            async (rt) => {
                await rt.initialize();
                this.#runtime = rt;
                return rt;
            }
        );

        return this.#initPromise;
    }

    /**
     * Generate a response from the elizaOS runtime.
     *
     * @param {AgentGenerateOptions} [args]
     * @returns {Promise<GenerateTextResult<Record<string, never>, unknown>>}
     */
    async generate(args = {}) {
        const { prompt, abortSignal, outputSchema, onStdout } = args;

        const promptText = typeof prompt === "string"
            ? prompt
            : prompt != null
                ? String(prompt)
                : "";

        const runtime = await this.#ensureRuntime();

        if (abortSignal?.aborted) {
            throw new Error("ElizaAgent: generation aborted");
        }

        /** @type {string} */
        let text;
        try {
            text = await runtime.useModel("TEXT_LARGE", {
                prompt: promptText,
                stopSequences: [],
            });
        } catch (err) {
            // Fallback: some elizaOS builds expose TEXT_SMALL or TEXT
            try {
                text = await runtime.useModel("TEXT_SMALL", {
                    prompt: promptText,
                    stopSequences: [],
                });
            } catch {
                throw err;
            }
        }

        if (abortSignal?.aborted) {
            throw new Error("ElizaAgent: generation aborted after model call");
        }

        if (onStdout) {
            onStdout(text);
        }

        /** @type {unknown} */
        let output = undefined;
        if (outputSchema) {
            try {
                const parsed = JSON.parse(text);
                output = outputSchema.parse(parsed);
            } catch {
                // Leave output undefined — prompt-based extraction; no native structured path.
            }
        }

        return buildGenerateResult(text, output, this.#modelId, undefined);
    }

    /**
     * Gracefully stop the runtime and release any held resources.
     *
     * @returns {Promise<void>}
     */
    async stop() {
        const rt = this.#runtime;
        this.#runtime = null;
        this.#initPromise = null;
        if (rt?.stop) {
            await rt.stop();
        }
    }
}
