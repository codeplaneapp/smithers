/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { useInjectUiCss } from "../styles";
import { MessageResponse as Response } from "./MessageResponse";
import { Reasoning, ReasoningSummary } from "./Reasoning";
import { REASONING_TOOLS_CSS_ID, reasoningToolsCss } from "./reasoningToolsCss";
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
  durationMs?: number;
};

export type AgentOutputModel = {
  response?: string;
  /**
   * Provider-safe reasoning summary: text the provider/harness explicitly
   * disclosed as a summary (reasoningSummary fields, summary-typed parts,
   * nested summary arrays). Raw reasoning/thinking transcripts are dropped by
   * the parser and never rendered. Never raw private chain-of-thought.
   */
  reasoningSummary?: string;
  /** @deprecated Use reasoningSummary. Both are populated identically. */
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
  useInjectLaneCss(REASONING_TOOLS_CSS_ID, reasoningToolsCss);
  const summary = model.reasoningSummary ?? model.reasoning;
  return (
    <div
      data-slot="agent-output"
      data-streaming={model.streaming ? "true" : "false"}
      className={cn("sui-agent-output", className)}
      {...props}
    >
      {summary ? (
        <Reasoning
          streaming={model.streaming}
          defaultOpen={model.streaming ? undefined : !model.response}
        >
          <ReasoningSummary
            text={summary}
            streaming={model.streaming && !model.response}
          />
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
              durationMs={call.durationMs}
            />
          ))}
        </div>
      ) : null}
      {model.response ? <Response content={model.response} streaming={model.streaming} /> : null}
    </div>
  );
}
