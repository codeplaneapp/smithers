import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, type ToolSet } from "ai";
import {
  resolveSdkModel,
  streamResultToGenerateResult,
  type SdkAgentOptions,
} from "./sdk-shared";

export type AnthropicAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
> = SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof anthropic>>;

export class AnthropicAgent<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
> extends ToolLoopAgent<CALL_OPTIONS, TOOLS> {
  constructor(opts: AnthropicAgentOptions<CALL_OPTIONS, TOOLS>) {
    const { model, ...rest } = opts;
    super({
      ...rest,
      model: resolveSdkModel(model, anthropic),
    } as any);
  }

  generate(args: {
    options?: CALL_OPTIONS;
    abortSignal?: AbortSignal;
    prompt: string;
    timeout?: { totalMs: number; idleMs?: number };
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    outputSchema?: import("zod").ZodObject<any>;
  }) {
    if (!args.onStdout) {
      return super.generate({
        options: args.options as CALL_OPTIONS,
        abortSignal: args.abortSignal,
        prompt: args.prompt,
        timeout: args.timeout as any,
      } as any);
    }

    return super.stream({
      options: args.options as CALL_OPTIONS,
      abortSignal: args.abortSignal,
      prompt: args.prompt,
      timeout: args.timeout as any,
    } as any).then((stream) => streamResultToGenerateResult(stream, args.onStdout));
  }
}
