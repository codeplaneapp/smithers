/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

/** Pulsing placeholder block. Size it with `style` or a consumer class. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="skeleton" aria-hidden className={cn("sui-skeleton", className)} {...props} />;
}
