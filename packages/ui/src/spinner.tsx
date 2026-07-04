/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

export const spinnerVariants = cva("sui-spinner", {
  variants: {
    size: {
      sm: "sui-spinner-sm",
      default: "",
      lg: "sui-spinner-lg",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

export type SpinnerProps = ComponentProps<"span"> & VariantProps<typeof spinnerVariants>;

/**
 * Small inline loading spinner (currentColor, so it tints with its context).
 * Announces as status for screen readers.
 */
export function Spinner({ className, size, "aria-label": ariaLabel, ...props }: SpinnerProps) {
  useInjectUiCss();
  return (
    <span
      data-slot="spinner"
      role="status"
      aria-label={ariaLabel ?? "Loading"}
      className={cn(spinnerVariants({ size }), className)}
      {...props}
    />
  );
}
