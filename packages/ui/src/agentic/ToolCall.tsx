/** @jsxImportSource react */
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { StatusPill } from "../status-pill";
import { useInjectUiCss } from "../styles";
import { formatJsonSafe } from "./formatJsonSafe";

export type ToolCallState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "running"
  | "output-available"
  | "output-error"
  | "output-denied";

export const TOOL_CALL_STATE_LABELS: Readonly<Record<ToolCallState, string>> = {
  "input-streaming": "Streaming input",
  "input-available": "Ready",
  "approval-requested": "Needs approval",
  "approval-responded": "Approved",
  running: "Running",
  "output-available": "Done",
  "output-error": "Failed",
  "output-denied": "Denied",
};

/** Map the tool lifecycle onto the shared status vocabulary. */
export function toolCallStatus(
  state: ToolCallState,
): "running" | "pending" | "waiting-approval" | "complete" | "error" | "denied" {
  switch (state) {
    case "input-streaming":
    case "running":
      return "running";
    case "input-available":
    case "approval-responded":
      return "pending";
    case "approval-requested":
      return "waiting-approval";
    case "output-available":
      return "complete";
    case "output-error":
      return "error";
    case "output-denied":
      return "denied";
  }
}

export type ToolCallProps = Omit<ComponentProps<"div">, "children"> & {
  name: string;
  state: ToolCallState;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  resultText?: string;
  errorText?: string;
  layout?: "compact" | "expanded";
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  approvalSlot?: ReactNode;
};

/** Tool invocation status, input, output, and approval surface. */
export function ToolCall({
  name,
  state,
  args,
  argsText,
  result,
  resultText,
  errorText,
  layout = "compact",
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  approvalSlot,
  className,
  ...props
}: ToolCallProps) {
  useInjectUiCss();
  const bodyId = `${useId()}-tool-call-body`;
  const expanded = layout === "expanded";
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = expanded ? true : isControlled ? controlledOpen : uncontrolledOpen;
  const hasArgs = argsText !== undefined || args !== undefined;
  const hasResult = resultText !== undefined || result !== undefined;
  const isFailure = state === "output-error" || state === "output-denied";

  function toggle() {
    const next = !isOpen;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  const heading = (
    <>
      {!expanded ? (
        <span className="sui-toolcall-chevron" aria-hidden="true">
          ›
        </span>
      ) : null}
      <span className="sui-toolcall-name">{name}</span>
      <StatusPill
        status={toolCallStatus(state)}
        label={TOOL_CALL_STATE_LABELS[state]}
      />
    </>
  );

  return (
    <div
      data-slot="tool-call"
      data-state={isOpen ? "open" : "closed"}
      data-layout={layout}
      className={cn("sui-toolcall", className)}
      {...props}
    >
      {expanded ? (
        <div data-slot="tool-call-header" className="sui-toolcall-header">
          {heading}
        </div>
      ) : (
        <button
          type="button"
          data-slot="tool-call-trigger"
          className="sui-toolcall-trigger"
          aria-expanded={isOpen}
          aria-controls={bodyId}
          onClick={toggle}
        >
          {heading}
        </button>
      )}
      {state === "approval-requested" && approvalSlot != null ? (
        <div data-slot="tool-call-approval" className="sui-toolcall-approval">
          {approvalSlot}
        </div>
      ) : null}
      {isOpen ? (
        <div data-slot="tool-call-body" id={bodyId} className="sui-toolcall-body">
          {hasArgs ? (
            <section data-slot="tool-call-args" className="sui-toolcall-section">
              <div className="sui-toolcall-section-title">Input</div>
              <pre className="sui-toolcall-pre">{argsText ?? formatJsonSafe(args)}</pre>
            </section>
          ) : null}
          {isFailure ? (
            <section data-slot="tool-call-result" className="sui-toolcall-section">
              <div className="sui-toolcall-section-title">Output</div>
              <pre className="sui-toolcall-pre sui-toolcall-error">
                {errorText ?? (state === "output-denied" ? "Denied" : "Tool call failed")}
              </pre>
            </section>
          ) : hasResult ? (
            <section data-slot="tool-call-result" className="sui-toolcall-section">
              <div className="sui-toolcall-section-title">Output</div>
              <pre className="sui-toolcall-pre">{resultText ?? formatJsonSafe(result)}</pre>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
