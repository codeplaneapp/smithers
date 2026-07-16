import { anthropic } from "@ai-sdk/anthropic";
import { Output, ToolLoopAgent, } from "ai";
import { resolveSdkModel } from "./resolveSdkModel.js";
import { streamResultToGenerateResult } from "./streamResultToGenerateResult.js";
/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */

/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./AnthropicAgentOptions.ts").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */

/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("ai").ToolSet]
 * @extends {ToolLoopAgent<CALL_OPTIONS, TOOLS, any, never>}
 */
export class AnthropicAgent extends ToolLoopAgent {
    hijackEngine = "anthropic-sdk";
    supportsNativeStructuredOutput = true;
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
        const outputArgs = args.outputSchema
            ? { output: Output.object({ schema: args.outputSchema }) }
            : {};
        const toolArgs = args.tools && typeof args.tools === "object"
            ? { tools: args.tools }
            : {};
        const onStepEnd = args.onStepEnd ?? args.onStepFinish;
        if (!args.onStdout) {
            return super.generate({
                options: args.options,
                abortSignal: args.abortSignal,
                ...promptArgs,
                ...outputArgs,
                ...toolArgs,
                timeout: args.timeout,
                onStepEnd,
            });
        }
        return super.stream({
            options: args.options,
            abortSignal: args.abortSignal,
            ...promptArgs,
            ...outputArgs,
            ...toolArgs,
            timeout: args.timeout,
            onStepEnd,
        }).then((stream) => streamResultToGenerateResult(stream, args.onStdout));
    }
}
