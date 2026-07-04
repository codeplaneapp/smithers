import type { ComponentProps } from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

export type ProgressProps = ComponentProps<typeof ProgressPrimitive.Root>;

/** Determinate progress bar (brand fill on the muted track), Radix a11y semantics. */
export function Progress({ className, value, ...props }: ProgressProps) {
  useInjectUiCss();
  return (
    <ProgressPrimitive.Root data-slot="progress" value={value} className={cn("sui-progress", className)} {...props}>
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="sui-progress-indicator"
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
