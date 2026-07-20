/** @jsxImportSource react */
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { formatStatus, statusClass } from "../status";
import { useInjectUiCss } from "../styles";

export type ChainOfThoughtStepStatus = "pending" | "active" | "done";

export type ChainOfThoughtStep = {
  id: string;
  label: ReactNode;
  status?: ChainOfThoughtStepStatus;
  detail?: ReactNode;
};

export type ChainOfThoughtProps = Omit<ComponentProps<"div">, "children"> & {
  steps: readonly ChainOfThoughtStep[];
  streaming?: boolean;
  title?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** Map chain-of-thought states into the shared status vocabulary. */
export function chainOfThoughtStepStatus(
  status: ChainOfThoughtStepStatus | undefined,
): "pending" | "running" | "complete" {
  if (status === "active") return "running";
  if (status === "done") return "complete";
  return "pending";
}

/** Ordered, streaming-aware reasoning steps. */
export function ChainOfThought({
  steps,
  streaming = false,
  title = "Chain of thought",
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: ChainOfThoughtProps) {
  useInjectUiCss();
  const bodyId = `${useId()}-chain-of-thought-body`;
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(
    () => defaultOpen ?? streaming,
  );
  const previousStreaming = useRef(streaming);
  const userToggled = useRef(false);
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  useEffect(() => {
    const previous = previousStreaming.current;
    previousStreaming.current = streaming;
    if (previous === streaming || isControlled || userToggled.current) return;
    setUncontrolledOpen(streaming);
    onOpenChange?.(streaming);
  }, [isControlled, onOpenChange, streaming]);

  function toggle() {
    const next = !isOpen;
    userToggled.current = true;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <div
      data-slot="chain-of-thought"
      data-state={isOpen ? "open" : "closed"}
      data-streaming={streaming ? "true" : "false"}
      className={cn("sui-cot", className)}
      {...props}
    >
      <button
        type="button"
        data-slot="chain-of-thought-trigger"
        className="sui-cot-trigger"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <span className="sui-cot-chevron" aria-hidden="true">
          ›
        </span>
        <span className="sui-cot-title" data-shimmer={streaming ? "true" : "false"}>
          {title}
        </span>
      </button>
      {isOpen ? (
        <div data-slot="chain-of-thought-body" id={bodyId} className="sui-cot-body">
          <ol className="sui-cot-steps">
            {steps.map((step) => {
              const mapped = chainOfThoughtStepStatus(step.status);
              return (
                <li
                  key={step.id}
                  data-slot="chain-of-thought-step"
                  data-status={mapped}
                  data-status-class={statusClass(mapped)}
                  className="sui-cot-step"
                >
                  <span className="sui-cot-step-dot" aria-hidden="true" />
                  <span className="sui-sr-only">{formatStatus(mapped)}: </span>
                  <span className="sui-cot-step-label">{step.label}</span>
                  {step.detail != null ? (
                    <div className="sui-cot-step-detail">{step.detail}</div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
