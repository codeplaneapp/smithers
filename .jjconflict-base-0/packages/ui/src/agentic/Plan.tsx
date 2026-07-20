/** @jsxImportSource react */
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { formatStatus, statusClass } from "../status";
import { useInjectUiCss } from "../styles";

export type PlanStepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export type PlanStep = {
  id: string;
  label: string;
  status: PlanStepStatus;
  detail?: ReactNode;
  defaultOpen?: boolean;
};

export type PlanProps = Omit<ComponentProps<"section">, "children" | "title"> & {
  title?: string;
  steps: readonly PlanStep[];
  streaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  openStepIds?: readonly string[];
  onOpenStepIdsChange?: (ids: string[]) => void;
};

/** Map plan states onto the shared status vocabulary. */
export function planStepStatus(status: PlanStepStatus): "pending" | "running" | "complete" | "failed" | "skipped" {
  switch (status) {
    case "active":
      return "running";
    case "done":
      return "complete";
    default:
      return status;
  }
}

function PlanStepRow({
  step,
  open,
  onOpenChange,
}: {
  step: PlanStep;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bodyId = useId();
  const mappedStatus = planStepStatus(step.status);

  return (
    <li
      data-slot="plan-step"
      data-status={mappedStatus}
      data-status-class={statusClass(mappedStatus)}
      data-state={open ? "open" : "closed"}
      className="sui-plan-step"
    >
      <div className="sui-plan-step-row">
        <span className="sui-plan-step-dot" aria-hidden="true" />
        <span className="sui-sr-only">{formatStatus(mappedStatus)}: </span>
        <span className="sui-plan-step-label">{step.label}</span>
        {step.detail !== undefined ? (
          <button
            type="button"
            data-slot="plan-step-toggle"
            className="sui-plan-step-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={`Details: ${step.label}`}
            onClick={() => onOpenChange(!open)}
          >
            Details
          </button>
        ) : null}
      </div>
      {step.detail !== undefined && open ? (
        <div data-slot="plan-step-detail" id={bodyId} className="sui-plan-step-detail">
          {step.detail}
        </div>
      ) : null}
    </li>
  );
}

/** Structured, collapsible progress plan with optional per-step details. */
export function Plan({
  title = "Plan",
  steps,
  streaming = false,
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  openStepIds: controlledOpenStepIds,
  onOpenStepIdsChange,
  className,
  ...props
}: PlanProps) {
  useInjectUiCss();
  const bodyId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [uncontrolledOpenStepIds, setUncontrolledOpenStepIds] = useState<string[]>(() =>
    steps.filter((step) => step.detail !== undefined && (step.defaultOpen ?? false)).map((step) => step.id),
  );
  const isControlled = controlledOpen !== undefined;
  const isStepsControlled = controlledOpenStepIds !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const openStepIds = isStepsControlled ? controlledOpenStepIds : uncontrolledOpenStepIds;
  const done = steps.filter((step) => step.status === "done").length;

  function togglePlan() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  function setStepOpen(stepId: string, nextOpen: boolean) {
    const current = new Set(openStepIds);
    if (nextOpen) current.add(stepId);
    else current.delete(stepId);
    const next = steps.filter((step) => current.has(step.id)).map((step) => step.id);
    if (!isStepsControlled) setUncontrolledOpenStepIds(next);
    onOpenStepIdsChange?.(next);
  }

  return (
    <section
      data-slot="plan"
      data-state={open ? "open" : "closed"}
      data-streaming={streaming ? "true" : "false"}
      className={cn("sui-plan", className)}
      {...props}
    >
      <div className="sui-plan-header">
        <button
          type="button"
          data-slot="plan-trigger"
          className="sui-plan-trigger"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={togglePlan}
        >
          <span className="sui-plan-chevron" aria-hidden="true">›</span>
          <span className="sui-plan-title" data-shimmer={streaming ? "true" : "false"}>
            {title}
          </span>
        </button>
        <span data-slot="plan-summary" className="sui-plan-summary">
          {done}/{steps.length} done
        </span>
      </div>
      {open ? (
        <ol data-slot="plan-steps" id={bodyId} className="sui-plan-steps">
          {steps.map((step) => (
            <PlanStepRow
              key={step.id}
              step={step}
              open={openStepIds.includes(step.id)}
              onOpenChange={(next) => setStepOpen(step.id, next)}
            />
          ))}
        </ol>
      ) : null}
    </section>
  );
}
