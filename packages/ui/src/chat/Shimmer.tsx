/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { CONVERSATION_FOUNDATION_CSS_ID, conversationFoundationCss } from "./conversationFoundationCss";

export type ShimmerProps = ComponentProps<"span"> & {
  active?: boolean;
};

/** Token-native text shimmer for live status labels. */
export function Shimmer({ active = true, className, ...props }: ShimmerProps) {
  useInjectUiCss();
  useInjectLaneCss(CONVERSATION_FOUNDATION_CSS_ID, conversationFoundationCss);
  return (
    <span
      data-slot="shimmer"
      data-active={active ? "true" : "false"}
      className={cn("sui-shimmer", className)}
      {...props}
    />
  );
}
