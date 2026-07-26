import { buildGenerateResult, extractPrompt, truncate } from "@smithers-orchestrator/agents/BaseCliAgent";

/** @typedef {import("./ElizaAgentOptions.ts").ElizaAgentOptions} ElizaAgentOptions */
/** @typedef {import("./ElizaAgentOptions.ts").ElizaPlugin} ElizaPlugin */
/** @typedef {import("@smithers-orchestrator/agents").AgentGenerateOptions} AgentGenerateOptions */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */

/**
 * Internal interface for the elizaOS AgentRuntime — structural only, so we
 * don't hard-depend on @elizaos/core at module load time.
 * @typedef {{
 *   initialize(): Promise<void>;
 *   useModel(modelType: string, params: { prompt: string; stopSequences?: string[]; abortSignal?: AbortSignal }): Promise<string>;
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
 * `@elizaos/core` is a hard dependency this package owns, so a load failure is
 * almost never a missing install — it is far more likely an ESM/CJS interop
 * break, a native-build failure, or a version conflict. Preserve the underlying
 * error as `cause` rather than masking it behind a fixed "install it" message.
 *
 * @param {ElizaAgentOptions} opts
 * @param {{ loadCore?: () => Promise<unknown> }} [seams]
 *   Test seam — inject an alternate `@elizaos/core` loader. Defaults to a real
 *   dynamic import of the bundled dependency.
 * @returns {Promise<ElizaRuntime>}
 */
export async function defaultRuntimeFactory(opts, { loadCore = () => import("@elizaos/core") } = {}) {
  /** @type {any} */
  let core;
  try {
    core = await loadCore();
  } catch (err) {
    throw new Error(
      "ElizaAgent: failed to load @elizaos/core (install it with `npm install @elizaos/core` if missing)",
      { cause: err },
    );
  }

  const AgentRuntime = core.AgentRuntime ?? core.default?.AgentRuntime;
  if (!AgentRuntime) {
    throw new Error(
      "@elizaos/core loaded but AgentRuntime was not found. " + "Ensure @elizaos/core@~1.7.2 is installed.",
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
    // elizaOS 1.7.2 also reads settings at the top-level runtime option.
    settings: mergedSettings,
  });

  return runtime;
}

/**
 * Build an abort error whose `name` is `"AbortError"`. The driver's abort
 * classifier keys off the name (matching driver `withAbort` / `makeAbortError`),
 * so setting it keeps aborts from being misread as retryable task failures if
 * the message wording ever changes.
 *
 * @returns {Error}
 */
function makeAbortError() {
  const error = new Error("ElizaAgent: generation aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Race a promise against an AbortSignal, rejecting immediately if the signal
 * fires. Returns the original promise unchanged if abortSignal is absent.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | null | undefined} abortSignal
 * @returns {Promise<T>}
 */
function raceAbort(promise, abortSignal) {
  if (!abortSignal) return promise;
  if (abortSignal.aborted) {
    return Promise.reject(makeAbortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(makeAbortError());
    abortSignal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      abortSignal.removeEventListener("abort", onAbort);
    });
  });
}

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
 * consumers of `@smithers-orchestrator/agent-eliza` get it transitively.
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
  /** @type {boolean} Set to true by stop() to prevent re-initialization. */
  #stopped = false;
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
        "ElizaAgent: character.name is required. " + "Provide a valid elizaOS Character with at least a name.",
      );
    }
    // Attempt to construct the runtime (resolves @elizaos/core) so we
    // surface missing-dep errors at preflight time rather than at generate.
    await this.#ensureRuntime();
  }

  /**
   * Lazily construct + initialize the AgentRuntime exactly once.
   * Guards against concurrent initialization and against use after stop().
   *
   * @returns {Promise<ElizaRuntime>}
   */
  async #ensureRuntime() {
    if (this.#stopped) throw new Error("ElizaAgent: agent has been stopped");
    if (this.#runtime) return this.#runtime;
    if (this.#initPromise) return this.#initPromise;

    const initPromise = this.#runtimeFactory(this.#opts).then(async (rt) => {
      await rt.initialize();
      if (this.#stopped) {
        // stop() was called while we were initializing — clean up
        // and reject so the caller knows init was cancelled.
        if (rt.stop) await rt.stop().catch(() => {});
        throw new Error("ElizaAgent: agent was stopped during initialization");
      }
      this.#runtime = rt;
      return rt;
    });
    // A rejected init must not poison the agent forever. Clear the memo on
    // failure so a later call retries. Guard the identity check so we never
    // clobber a newer attempt (e.g. one already started after stop()/reset).
    initPromise.catch(() => {
      if (this.#initPromise === initPromise) this.#initPromise = null;
    });
    this.#initPromise = initPromise;

    return initPromise;
  }

  /**
   * Generate a response from the elizaOS runtime.
   *
   * @param {AgentGenerateOptions} [args]
   * @returns {Promise<GenerateTextResult<Record<string, never>, unknown>>}
   */
  async generate(args = {}) {
    const { abortSignal, outputSchema, onStdout } = args;

    // Route through the shared extractor so `messages` (AI-SDK chat history)
    // and array/object prompts are flattened to text instead of being
    // dropped or stringified to "[object Object]". System messages are
    // prepended so the runtime still sees them.
    const { prompt: extractedPrompt, systemFromMessages } = extractPrompt(args);
    const promptText = systemFromMessages ? `${systemFromMessages}\n\n${extractedPrompt}` : extractedPrompt;

    if (abortSignal?.aborted) {
      throw makeAbortError();
    }

    const runtime = await raceAbort(this.#ensureRuntime(), abortSignal);

    /** @param {string} modelType */
    const callModel = (modelType) =>
      raceAbort(
        runtime.useModel(modelType, {
          prompt: promptText,
          stopSequences: [],
          abortSignal,
        }),
        abortSignal,
      );

    /** @type {string} */
    let text;
    try {
      text = await callModel("TEXT_LARGE");
    } catch (err) {
      // Only fall back on unrecognised model-type errors, not transient
      // failures (network, rate-limit, auth) which should surface directly.
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      const unsupportedModelType =
        msg.includes("unsupported model") ||
        msg.includes("unknown model") ||
        msg.includes("not supported") ||
        msg.includes("invalid model type") ||
        msg.includes("model type not found");
      if (unsupportedModelType) {
        text = await callModel("TEXT_SMALL");
      } else {
        throw err;
      }
    }

    if (onStdout) {
      onStdout(text);
    }

    /** @type {unknown} */
    let output = undefined;
    if (outputSchema) {
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error(
          `ElizaAgent: expected JSON output for outputSchema but the model returned non-JSON text: ${truncate(text, 200)}`,
          { cause: err },
        );
      }
      output = outputSchema.parse(parsed);
    }

    return buildGenerateResult(text, output, this.#modelId, undefined);
  }

  /**
   * Gracefully stop the runtime and release any held resources.
   * Safe to call before init or while init is in progress.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this.#stopped = true;
    const rt = this.#runtime;
    const pending = this.#initPromise;
    this.#runtime = null;
    this.#initPromise = null;

    if (rt) {
      // Runtime already fully initialized — stop it directly.
      if (rt.stop) await rt.stop();
    } else if (pending) {
      // Init is still in progress. Wait for it: the .then() block above
      // will see #stopped=true, call rt.stop(), and then throw — which
      // we swallow here since stopping is the intended outcome.
      await pending.catch(() => {});
    }
  }
}
