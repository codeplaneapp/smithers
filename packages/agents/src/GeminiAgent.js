import { BaseCliAgent } from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList } from "./capability-registry/index.js";

/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./GeminiAgentOptions.ts").GeminiAgentOptions} GeminiAgentOptions */

export const GEMINI_SUNSET_MESSAGE = [
    "Gemini CLI support has been sunset in Smithers.",
    "Use AntigravityAgent with Google's `agy` CLI instead.",
    "Example:",
    '  import { AntigravityAgent } from "smithers-orchestrator";',
    '  const agent = new AntigravityAgent({ model: "gemini-3.1-pro-preview", cwd: process.cwd() });',
].join("\n");

/**
 * @param {GeminiAgentOptions} opts
 */
function resolveGeminiBuiltIns(opts) {
    return opts.allowedTools?.length
        ? normalizeCapabilityStringList(opts.allowedTools)
        : ["sunset"];
}

/**
 * @param {GeminiAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createGeminiCapabilityRegistry(opts = {}) {
    return {
        version: 1,
        engine: "gemini",
        runtimeTools: {},
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
        builtIns: resolveGeminiBuiltIns(opts),
    };
}

/**
 * @deprecated Gemini CLI support has been sunset. Use AntigravityAgent with
 * Google's `agy` CLI instead.
 */
export class GeminiAgent extends BaseCliAgent {
    opts;
    capabilities;
    cliEngine = "gemini";

    /**
   * @param {GeminiAgentOptions} [opts]
   */
    constructor(opts = {}) {
        super(opts);
        this.opts = opts;
        this.capabilities = createGeminiCapabilityRegistry(opts);
    }

    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter() {
        return {
            onStdoutLine: () => [],
            onExit: () => [{
                    type: "completed",
                    engine: this.cliEngine,
                    ok: false,
                    error: GEMINI_SUNSET_MESSAGE,
                }],
        };
    }

    async generate() {
        throw new Error(GEMINI_SUNSET_MESSAGE);
    }

    async buildCommand() {
        throw new Error(GEMINI_SUNSET_MESSAGE);
    }
}
