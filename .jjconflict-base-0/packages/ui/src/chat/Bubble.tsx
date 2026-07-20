/** @jsxImportSource react */
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { cva } from "class-variance-authority";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

const bubbleVariantClasses = cva("sui-bubble", {
  variants: {
    variant: {
      user: "sui-bubble-user",
      assistant: "sui-bubble-assistant",
      system: "sui-bubble-system",
    },
  },
  defaultVariants: {
    variant: "assistant",
  },
});

export const bubbleVariants: (props?: {
  variant?: "user" | "assistant" | "system";
}) => string = (props) => bubbleVariantClasses(props);

export type BubbleProps = ComponentProps<"div"> & {
  variant?: "user" | "assistant" | "system";
  align?: "start" | "end" | "center";
  collapsible?: boolean;
  collapsedHeight?: number;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  expandLabel?: string;
  collapseLabel?: string;
};

type BubbleStyle = CSSProperties & { "--sui-bubble-clamp"?: string };

/** Message surface with role variants and mounted-content clamp disclosure. */
export function Bubble({
  variant = "assistant",
  align,
  collapsible = false,
  collapsedHeight = 320,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  expandLabel = "Show more",
  collapseLabel = "Show less",
  className,
  style,
  children,
  ...props
}: BubbleProps) {
  useInjectUiCss();
  const bodyId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const [overflows, setOverflows] = useState(collapsible);
  const isExpanded = expanded ?? internalExpanded;
  const resolvedAlign = align ?? (variant === "user" ? "end" : variant === "system" ? "center" : "start");

  useLayoutEffect(() => {
    if (!collapsible) return;
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") {
      setOverflows(true);
      return;
    }
    const measure = () => setOverflows(content.scrollHeight > collapsedHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [collapsible, collapsedHeight]);

  const requestExpanded = (next: boolean) => {
    if (expanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
  };

  const rootStyle: BubbleStyle = collapsible
    ? { ...(style as BubbleStyle), "--sui-bubble-clamp": `${collapsedHeight}px` }
    : (style as BubbleStyle);

  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={resolvedAlign}
      data-expanded={collapsible ? String(isExpanded) : undefined}
      className={cn(bubbleVariants({ variant }), className)}
      style={rootStyle}
      {...props}
    >
      <div
        ref={contentRef}
        data-slot="bubble-content"
        id={bodyId}
        className="sui-bubble-content"
      >
        {children}
      </div>
      {collapsible && overflows ? (
        <button
          type="button"
          data-slot="bubble-toggle"
          className="sui-bubble-toggle"
          aria-expanded={isExpanded}
          aria-controls={bodyId}
          onClick={() => requestExpanded(!isExpanded)}
        >
          {isExpanded ? collapseLabel : expandLabel}
        </button>
      ) : null}
    </div>
  );
}
