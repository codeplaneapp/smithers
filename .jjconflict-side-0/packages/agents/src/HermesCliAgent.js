import { BaseCliAgent, pushFlag } from "./BaseCliAgent/index.js";

/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./HermesCliAgentOptions.ts").HermesCliAgentOptions} HermesCliAgentOptions */

/**
 * Capability registry for the Hermes Agent CLI.
 *
 * @returns {AgentCapabilityRegistry}
 */
export function createHermesCliCapabilityRegistry() {
  return {
    version: 1,
    engine: "hermes",
    runtimeTools: {},
    // Hermes is a native MCP client, but its servers are config-driven
    // (`~/.hermes/config.yaml`), not bootstrapped by Smithers per run.
    mcp: {
      bootstrap: "unsupported",
      supportsProjectScope: false,
      supportsUserScope: false,
    },
    skills: {
      supportsSkills: false,
      smithersSkillIds: [],
    },
    humanInteraction: {
      supportsUiRequests: false,
      methods: [],
    },
    builtIns: ["default"],
  };
}

/**
 * Hermes Agent (Nous Research) driven through its `hermes` CLI.
 *
 * Uses the headless one-shot entry point `hermes -z "<prompt>"`: a single prompt
 * in, the agent's final response text out, nothing else on stdout/stderr. This
 * is the CLI coding agent, a peer of Claude Code / Codex — not the Hermes model
 * API (see {@link HermesAgent} for that). Reach for this to make a workflow
 * `<Task>` delegate to Hermes itself.
 */
export class HermesCliAgent extends BaseCliAgent {
  opts;
  /** @type {AgentCapabilityRegistry} */
  capabilities;
  cliEngine = "hermes";

  /**
   * @param {HermesCliAgentOptions} [opts]
   */
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
    this.capabilities = createHermesCliCapabilityRegistry();
  }

  /**
   * @returns {CliOutputInterpreter}
   */
  createOutputInterpreter() {
    let emittedStarted = false;
    return {
      onStdoutLine: () => {
        if (emittedStarted) return [];
        emittedStarted = true;
        return [{ type: "started", engine: this.cliEngine, title: "Hermes" }];
      },
      onExit: (result) => {
        const started = !emittedStarted
          ? [{ type: "started", engine: this.cliEngine, title: "Hermes" }]
          : [];
        return [
          ...started,
          {
            type: "completed",
            engine: this.cliEngine,
            ok: !result.exitCode || result.exitCode === 0,
            answer: result.stdout.trim() || undefined,
            error:
              result.exitCode && result.exitCode !== 0
                ? result.stderr.trim() || `Hermes exited with code ${result.exitCode}`
                : undefined,
          },
        ];
      },
    };
  }

  /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
  async buildCommand(params) {
    const args = [];

    // Model + provider.
    pushFlag(args, "--model", this.opts.model ?? this.model);
    pushFlag(args, "--provider", this.opts.provider);

    // Resume: a per-call resumeSession wins over the configured continueSession.
    // `-r <session>` resumes a specific session id; `-c [name]` continues the
    // most recent (or a named) session.
    const resumeSession =
      typeof params.options?.resumeSession === "string" ? params.options.resumeSession : undefined;
    if (resumeSession) {
      pushFlag(args, "-r", resumeSession);
    } else if (typeof this.opts.continueSession === "string") {
      pushFlag(args, "-c", this.opts.continueSession);
    } else if (this.opts.continueSession === true) {
      args.push("-c");
    }

    if (this.extraArgs?.length) args.push(...this.extraArgs);

    // `hermes -z` has no separate system-prompt flag — prepend it to the prompt.
    const systemPrefix = params.systemPrompt ? `${params.systemPrompt}\n\n` : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;
    // `-z` must come last with the prompt as its value so option flags above are
    // parsed as flags, not swallowed as part of the one-shot prompt.
    args.push("-z", fullPrompt);

    return {
      command: "hermes",
      args,
      // Hermes -z emits the final response as plain text only. The working
      // directory is the agent's cwd, set by BaseCliAgent (cwd / rootDir).
      outputFormat: "text",
    };
  }
}
