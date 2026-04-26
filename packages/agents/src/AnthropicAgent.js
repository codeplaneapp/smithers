import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, } from "ai";
import { resolveSdkModel } from "./resolveSdkModel.js";
import { streamResultToGenerateResult } from "./streamResultToGenerateResult.js";
/** @typedef {import("ai").AgentCallParameters} AgentCallParameters */
/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */

/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./AnthropicAgentOptions.ts").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/**
 * @template CALL_OPTIONS, TOOLS
 * @typedef {AgentCallParameters<CALL_OPTIONS, TOOLS> & { onStdout?: (text: string) => void; onStderr?: (text: string) => void; onEvent?: (event: unknown) => Promise<void> | void; outputSchema?: import("zod").ZodTypeAny; resumeSession?: string; }} ExtendedGenerateArgs
 */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */

export class AnthropicAgent extends ToolLoopAgent {
    hijackEngine = "anthropic-sdk";
    /**
   * @param {AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} opts
   */
    constructor(opts) {
        const { model, ...rest } = opts;
        super({
            ...rest,
            model: resolveSdkModel(model, anthropic),
        });
    }
    /**
   * @param {AgentGenerateOptions} [args]
   * @returns {Promise<GenerateTextResult<TOOLS, never>>}
   */
    generate(args = {}) {
        const promptArgs = "messages" in args
            ? { messages: args.messages }
            : { prompt: args.prompt };
        if (!args.onStdout) {
            return super.generate({
                options: args.options,
                abortSignal: args.abortSignal,
                ...promptArgs,
                timeout: args.timeout,
                onStepFinish: args.onStepFinish,
            });
        }
        return super.stream({
            options: args.options,
            abortSignal: args.abortSignal,
            ...promptArgs,
            timeout: args.timeout,
            onStepFinish: args.onStepFinish,
        }).then((stream) => streamResultToGenerateResult(stream, args.onStdout));
    }
}
