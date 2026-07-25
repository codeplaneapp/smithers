/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

export type ProgressProps = ComponentProps<typeof ProgressPrimitive.Root>;

/** Determinate progress bar (brand fill on the muted track), Radix a11y semantics. */
export function Progress({ className, value, max, ...props }: ProgressProps) {
  useInjectUiCss();
  // Radix falls back to 100 for a missing/invalid max; mirror that so the fill matches the announced value.
  const ceiling = typeof max === "number" && Number.isFinite(max) && max > 0 ? max : 100;
  const percent = Math.min(100, Math.max(0, ((value ?? 0) / ceiling) * 100));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      max={max}
      className={cn("sui-progress", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="sui-progress-indicator"
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
