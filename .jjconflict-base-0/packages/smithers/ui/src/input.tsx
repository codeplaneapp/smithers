/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

/** Text input on the house control metrics (32px, 6px radius, brand focus ring). */
export function Input({ className, ...props }: ComponentProps<"input">) {
  useInjectUiCss();
  return <input data-slot="input" className={cn("sui-input", className)} {...props} />;
}

/** Multiline input matching the styleguide `.textarea`/`.prompt` (88px min, resize-y). */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  useInjectUiCss();
  return <textarea data-slot="textarea" className={cn("sui-textarea", className)} {...props} />;
}
