/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

export const badgeVariants = cva("sui-badge", {
  variants: {
    variant: {
      /** Brand-tinted pill (the styleguide `.pill` recipe). */
      default: "sui-badge-default",
      /** Quiet chip on a subtle wash. */
      secondary: "sui-badge-secondary",
      outline: "sui-badge-outline",
      /** Status tints shadcn lacks; StatusPill maps onto these. */
      success: "sui-badge-success",
      warning: "sui-badge-warning",
      destructive: "sui-badge-destructive",
      muted: "sui-badge-muted",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export type BadgeProps = ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    /** Render the child element instead of a `<span>` (Radix Slot). */
    asChild?: boolean;
  };

/**
 * Small uppercase pill, pixel-compatible with the styleguide
 * `.badge`/`.pill`/`.chip` vocabulary (22px, 11px mono-ish, rounded-full).
 */
export function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  useInjectUiCss();
  const Comp = asChild ? Slot.Root : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
