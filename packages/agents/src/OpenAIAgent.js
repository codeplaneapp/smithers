import { createOpenAI, openai } from "@ai-sdk/openai";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { jsonSchema, Output, ToolLoopAgent, } from "ai";
import { resolveSdkModel } from "./resolveSdkModel.js";
import { streamResultToGenerateResult } from "./streamResultToGenerateResult.js";
import { zodToOpenAISchema } from "./zodToOpenAISchema.js";

/**
 * OpenAI's strict structured-output mode rejects schemas where an object's
 * `required` omits any property key — which is exactly what Zod v4's
 * `toJSONSchema()` emits for `.optional()`/`.default()` fields. Route Zod
 * schemas through the same OpenAI sanitizer CodexAgent uses; pass anything
 * else (raw JSON schema, AI SDK Schema) through unchanged.
 *
 * @param {unknown} outputSchema
 * @returns {Promise<any>}
 */
async function toNativeOutputSchema(outputSchema) {
    if (outputSchema && typeof outputSchema === "object" && "_zod" in outputSchema) {
        return jsonSchema(await zodToOpenAISchema(/** @type {any} */ (outputSchema)));
    }
    return outputSchema;
}
/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */

/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./OpenAIAgentOptions.ts").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */

/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("ai").ToolSet]
 * @extends {ToolLoopAgent<CALL_OPTIONS, TOOLS, any, never>}
 */
export class OpenAIAgent extends ToolLoopAgent {
    hijackEngine = "openai-sdk";
    /**
   * @param {OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} opts
   */
    constructor(opts) {
        const { model, baseURL, apiKey, api, nativeStructuredOutput, ...rest } = opts;
        const hasProviderConfig = baseURL !== undefined || apiKey !== undefined;
        if ((hasProviderConfig || api !== undefined) && typeof model !== "string") {
            throw new SmithersError("AGENT_CONFIG_INVALID", "OpenAIAgent baseURL/apiKey/api can only be used when model is a string. For a prebuilt model, put provider settings in createOpenAI({ baseURL, apiKey }) before calling the provider.", {
                hasBaseURL: baseURL !== undefined,
                hasApiKey: apiKey !== undefined,
                hasApi: api !== undefined,
            });
        }
        const provider = hasProviderConfig
            ? createOpenAI({
                ...(baseURL !== undefined ? { baseURL } : {}),
                ...(apiKey !== undefined ? { apiKey } : {}),
            })
            : openai;
        const createModel = api === "chat" ? provider.chat : api === "responses" ? provider.responses : provider;
        super({
            ...rest,
            model: resolveSdkModel(model, createModel),
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
        const toolArgs = args.tools && typeof args.tools === "object"
            ? { tools: args.tools }
            : {};
        const onStepEnd = args.onStepEnd ?? args.onStepFinish;
        const run = async () => {
            const outputArgs = this.supportsNativeStructuredOutput && args.outputSchema
                ? { output: Output.object({ schema: await toNativeOutputSchema(args.outputSchema) }) }
                : {};
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
        };
        return run();
    }
}
