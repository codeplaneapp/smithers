/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { MessageResponse as Response } from "./MessageResponse";
import { Reasoning } from "./Reasoning";
import { ToolCall, type ToolCallState } from "./ToolCall";

export type AgentOutputToolCall = {
  id?: string;
  name: string;
  state: ToolCallState;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  resultText?: string;
  errorText?: string;
};

export type AgentOutputModel = {
  response?: string;
  reasoning?: string;
  toolCalls: readonly AgentOutputToolCall[];
  streaming: boolean;
};

export type AgentOutputProps = Omit<ComponentProps<"div">, "children"> & {
  model: AgentOutputModel;
};

/** Props-driven composition for a parsed assistant response, reasoning, and tools. */
export function AgentOutput({ model, className, ...props }: AgentOutputProps) {
  useInjectUiCss();
  return (
    <div
      data-slot="agent-output"
      data-streaming={model.streaming ? "true" : "false"}
      className={cn("sui-agent-output", className)}
      {...props}
    >
      {model.reasoning ? (
        <Reasoning
          streaming={model.streaming}
          defaultOpen={model.streaming ? undefined : !model.response}
        >
          <Response content={model.reasoning} streaming={model.streaming && !model.response} />
        </Reasoning>
      ) : null}
      {model.toolCalls.length ? (
        <div data-slot="agent-output-tools" className="sui-agent-output-tools">
          {model.toolCalls.map((call, index) => (
            <ToolCall
              key={call.id ?? `${call.name}:${index}`}
              name={call.name}
              state={call.state}
              args={call.args}
              argsText={call.argsText}
              result={call.result}
              resultText={call.resultText}
              errorText={call.errorText}
            />
          ))}
        </div>
      ) : null}
      {model.response ? <Response content={model.response} streaming={model.streaming} /> : null}
    </div>
  );
}
