/** @jsxImportSource react */
import { type ComponentProps, createContext, type ReactNode, useContext, useId, useState } from "react";
import { cn } from "../cn";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { formatStatus, statusClass } from "../status";
import { useInjectUiCss } from "../styles";
import { PLANS_TASKS_QUEUES_CSS_ID, plansTasksQueuesCss } from "./plansTasksQueuesCss";

export type PlanStepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export type PlanStepModel = {
  id: string;
  label: string;
  status: PlanStepStatus;
  detail?: ReactNode;
  defaultOpen?: boolean;
};

export type PlanLegacyProps = Omit<ComponentProps<"section">, "children" | "title"> & {
  title?: string;
  steps: readonly PlanStepModel[];
  streaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  openStepIds?: readonly string[];
  onOpenStepIdsChange?: (ids: string[]) => void;
  children?: never;
};

export type PlanCompoundProps = Omit<ComponentProps<"section">, "children" | "title"> & {
  streaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  steps?: never;
};

export type PlanProps = PlanLegacyProps | PlanCompoundProps;

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

type PlanContextValue = {
  open: boolean;
  toggle: () => void;
  streaming: boolean;
  triggerId: string | undefined;
  contentId: string | undefined;
};

const PlanContext = createContext<PlanContextValue | null>(null);

function usePlanContext(part: string): PlanContextValue {
  const context = useContext(PlanContext);
  if (!context) throw new Error(`${part} must render inside <Plan>`);
  return context;
}

function usePlanCss(): void {
  useInjectUiCss();
  useInjectLaneCss(PLANS_TASKS_QUEUES_CSS_ID, plansTasksQueuesCss);
}

/** Header row of a compound Plan; hosts PlanTrigger, PlanTitle, PlanAction. */
export function PlanHeader({ className, ...props }: ComponentProps<"div">) {
  usePlanCss();
  usePlanContext("PlanHeader");
  return <div data-slot="plan-header" className={cn("sui-plan-header", className)} {...props} />;
}

/** Title text of a compound Plan; shimmers while the plan streams. */
export function PlanTitle({ className, ...props }: ComponentProps<"div">) {
  usePlanCss();
  const { streaming } = usePlanContext("PlanTitle");
  return (
    <div
      data-slot="plan-title"
      data-shimmer={streaming ? "true" : "false"}
      className={cn("sui-plan-title", className)}
      {...props}
    />
  );
}

/** Optional descriptive text under the plan header. */
export function PlanDescription({ className, ...props }: ComponentProps<"div">) {
  usePlanCss();
  usePlanContext("PlanDescription");
  return <div data-slot="plan-description" className={cn("sui-plan-description", className)} {...props} />;
}

/** Compound-mode disclosure trigger toggling the Plan body. */
export function PlanTrigger({ className, children, onClick, ...props }: ComponentProps<"button">) {
  usePlanCss();
  const { open, toggle, triggerId, contentId } = usePlanContext("PlanTrigger");
  return (
    <button
      type="button"
      data-slot="plan-trigger"
      id={triggerId}
      className={cn("sui-plan-trigger", className)}
      aria-expanded={open}
      aria-controls={contentId}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) toggle();
      }}
      {...props}
    >
      <span className="sui-plan-chevron" aria-hidden="true">
        ›
      </span>
      {children}
    </button>
  );
}

/** Compound-mode body region of a Plan; mounted only while open. */
export function PlanContent({ className, ...props }: ComponentProps<"div">) {
  usePlanCss();
  const { open, triggerId, contentId } = usePlanContext("PlanContent");
  if (!open) return null;
  return (
    <div
      data-slot="plan-content"
      role="region"
      id={contentId}
      aria-labelledby={triggerId}
      className={cn("sui-plan-content", className)}
      {...props}
    />
  );
}

export type PlanStepProps = Omit<ComponentProps<"li">, "children" | "title"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  label: ReactNode;
  status?: PlanStepStatus;
  children?: ReactNode;
};

/**
 * A single collapsible plan step in the compound anatomy.
 */
export function PlanStep({
  label,
  status = "pending",
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  children,
  ...props
}: PlanStepProps) {
  usePlanCss();
  usePlanContext("PlanStep");
  const bodyId = useId();
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const mapped = planStepStatus(status);
  const hasDetail = children !== undefined && children !== null;

  function toggleDetail() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <li
      data-slot="plan-step"
      data-status={mapped}
      data-status-class={statusClass(mapped)}
      data-state={open ? "open" : "closed"}
      className={cn("sui-plan-step", className)}
      {...props}
    >
      <div className="sui-plan-step-row">
        <span className="sui-plan-step-dot" aria-hidden="true" />
        <span className="sui-sr-only">
          {formatStatus(mapped)}:{" "}
        </span>
        <span className="sui-plan-step-label">{label}</span>
        {hasDetail ?
          (
            <button
              type="button"
              data-slot="plan-step-toggle"
              className="sui-plan-step-toggle"
              aria-expanded={open}
              aria-controls={bodyId}
              aria-label={typeof label === "string" ? `Details: ${label}` : "Step details"}
              onClick={toggleDetail}
            >
              Details
            </button>
          ) :
          null}
      </div>
      {hasDetail && open ?
        (
          <div data-slot="plan-step-detail" id={bodyId} className="sui-plan-step-detail">
            {children}
          </div>
        ) :
        null}
    </li>
  );
}

/** A small ghost button for plan-level actions (header or footer). */
export function PlanAction({ className, type, ...props }: ComponentProps<"button">) {
  usePlanCss();
  usePlanContext("PlanAction");
  return (
    <button type={type ?? "button"} data-slot="plan-action" className={cn("sui-plan-action", className)} {...props} />
  );
}

/** Footer row of a compound Plan. */
export function PlanFooter({ className, ...props }: ComponentProps<"div">) {
  usePlanCss();
  usePlanContext("PlanFooter");
  return <div data-slot="plan-footer" className={cn("sui-plan-footer", className)} {...props} />;
}

function PlanStepRow({
  step,
  open,
  onOpenChange,
}: {
  step: PlanStepModel;
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
        <span className="sui-sr-only">
          {formatStatus(mappedStatus)}:{" "}
        </span>
        <span className="sui-plan-step-label">{step.label}</span>
        {step.detail !== undefined ?
          (
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
          ) :
          null}
      </div>
      {step.detail !== undefined && open ?
        (
          <div data-slot="plan-step-detail" id={bodyId} className="sui-plan-step-detail">
            {step.detail}
          </div>
        ) :
        null}
    </li>
  );
}

function LegacyPlan({
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
}: PlanLegacyProps) {
  usePlanCss();
  const bodyId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [uncontrolledOpenStepIds, setUncontrolledOpenStepIds] = useState<string[]>(() =>
    steps.filter((step) => step.detail !== undefined && (step.defaultOpen ?? false)).map((step) => step.id)
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
          <span className="sui-plan-chevron" aria-hidden="true">
            ›
          </span>
          <span className="sui-plan-title" data-shimmer={streaming ? "true" : "false"}>
            {title}
          </span>
        </button>
        <span data-slot="plan-summary" className="sui-plan-summary">
          {done}/{steps.length} done
        </span>
      </div>
      {open ?
        (
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
        ) :
        null}
    </section>
  );
}

function CompoundPlan({
  streaming = false,
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  className,
  children,
  ...props
}: PlanCompoundProps) {
  usePlanCss();
  const triggerId = useId();
  const contentId = useId();
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  function toggle() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <PlanContext.Provider value={{ open, toggle, streaming, triggerId, contentId }}>
      <section
        data-slot="plan"
        data-state={open ? "open" : "closed"}
        data-streaming={streaming ? "true" : "false"}
        className={cn("sui-plan", className)}
        {...props}
      >
        {children}
      </section>
    </PlanContext.Provider>
  );
}

/** Structured, collapsible progress plan with optional per-step details. */
export function Plan(props: PlanProps) {
  if (props.steps !== undefined) return <LegacyPlan {...props} />;
  return <CompoundPlan {...props} />;
}
