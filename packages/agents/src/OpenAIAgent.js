import { createOpenAI, openai } from "@ai-sdk/openai";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { Output, ToolLoopAgent, } from "ai";
import { resolveSdkModel } from "./resolveSdkModel.js";
import { streamResultToGenerateResult } from "./streamResultToGenerateResult.js";
/** @typedef {import("ai").AgentCallParameters} AgentCallParameters */
/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */

/**
 * @template CALL_OPTIONS, TOOLS
 * @typedef {AgentCallParameters<CALL_OPTIONS, TOOLS> & { onStdout?: (text: string) => void; onStderr?: (text: string) => void; onEvent?: (event: unknown) => Promise<void> | void; outputSchema?: import("zod").ZodTypeAny; resumeSession?: string; }} ExtendedGenerateArgs
 */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./OpenAIAgentOptions.ts").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */

export class OpenAIAgent extends ToolLoopAgent {
    hijackEngine = "openai-sdk";
    /**
   * @param {OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} opts
   */
    constructor(opts) {
        const { model, baseURL, apiKey, nativeStructuredOutput, ...rest } = opts;
        const hasProviderConfig = baseURL !== undefined || apiKey !== undefined;
        if (hasProviderConfig && typeof model !== "string") {
            throw new SmithersError("AGENT_CONFIG_INVALID", "OpenAIAgent baseURL/apiKey can only be used when model is a string. For a prebuilt model, put provider settings in createOpenAI({ baseURL, apiKey }) before calling the provider.", {
                hasBaseURL: baseURL !== undefined,
                hasApiKey: apiKey !== undefined,
            });
        }
        const provider = hasProviderConfig
            ? createOpenAI({
                ...(baseURL !== undefined ? { baseURL } : {}),
                ...(apiKey !== undefined ? { apiKey } : {}),
            })
            : openai;
        super({
            ...rest,
            model: resolveSdkModel(model, provider),
        });
        this.supportsNativeStructuredOutput = nativeStructuredOutput !== false;
    }
    /**
   * @param {AgentGenerateOptions} [args]
   * @returns {Promise<GenerateTextResult<TOOLS, never>>}
   */
    generate(args = {}) {
        const promptArgs = "messages" in args
            ? { messages: args.messages }
            : { prompt: args.prompt };
        const outputArgs = this.supportsNativeStructuredOutput && args.outputSchema
            ? { output: Output.object({ schema: args.outputSchema }) }
            : {};
        if (!args.onStdout) {
            return super.generate({
                options: args.options,
                abortSignal: args.abortSignal,
                ...promptArgs,
                ...outputArgs,
                timeout: args.timeout,
                onStepFinish: args.onStepFinish,
            });
        }
        return super.stream({
            options: args.options,
            abortSignal: args.abortSignal,
            ...promptArgs,
            ...outputArgs,
            timeout: args.timeout,
            onStepFinish: args.onStepFinish,
        }).then((stream) => streamResultToGenerateResult(stream, args.onStdout));
    }
}
