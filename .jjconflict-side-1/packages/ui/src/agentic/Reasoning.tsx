/** @jsxImportSource react */
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type ReasoningProps = Omit<ComponentProps<"div">, "children"> & {
  streaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  title?: string;
  children?: ReactNode;
};

function formatDuration(n: number): string {
  if (n < 60) return `${Math.round(n)}s`;
  return `${Math.floor(n / 60)}m ${String(Math.round(n % 60)).padStart(2, "0")}s`;
}

/** Collapsible, streaming-aware extended reasoning content. */
export function Reasoning({
  streaming = false,
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  duration,
  title = "Reasoning",
  className,
  children,
  ...props
}: ReasoningProps) {
  useInjectUiCss();
  const bodyId = `${useId()}-reasoning-body`;
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
      data-slot="reasoning"
      data-state={isOpen ? "open" : "closed"}
      data-streaming={streaming ? "true" : "false"}
      className={cn("sui-reasoning", className)}
      {...props}
    >
      <button
        type="button"
        data-slot="reasoning-trigger"
        className="sui-reasoning-trigger"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <span className="sui-reasoning-chevron" aria-hidden="true">
          ›
        </span>
        <span
          className="sui-reasoning-title"
          data-shimmer={streaming ? "true" : "false"}
        >
          {title}
        </span>
        {!streaming && duration != null ? (
          <span data-slot="reasoning-duration" className="sui-reasoning-duration">
            Thought for {formatDuration(duration)}
          </span>
        ) : null}
      </button>
      {isOpen ? (
        <div data-slot="reasoning-body" id={bodyId} className="sui-reasoning-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}
