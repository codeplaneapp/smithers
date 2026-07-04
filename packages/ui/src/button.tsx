/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

export const buttonVariants = cva("sui-button", {
  variants: {
    variant: {
      /** The house primary recipe: tinted brand surface + brand text. */
      default: "sui-button-default",
      /** shadcn's filled look: solid brand background. */
      solid: "sui-button-solid",
      secondary: "sui-button-secondary",
      outline: "sui-button-outline",
      ghost: "sui-button-ghost",
      destructive: "sui-button-destructive",
      link: "sui-button-link",
    },
    size: {
      sm: "sui-button-sm",
      default: "",
      lg: "sui-button-lg",
      icon: "sui-button-icon-size",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a `<button>` (Radix Slot). */
    asChild?: boolean;
  };

/**
 * Button with shadcn variant anatomy on the Smithers theme tokens.
 *
 * `variant="default"` reproduces the house tinted-brand primary
 * (`.button.primary` in the styleguide) for visual continuity; use
 * `variant="solid"` for shadcn's filled look. Defaults `type="button"` so
 * buttons inside forms never submit accidentally.
 */
export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  useInjectUiCss();
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return <Slot.Root data-slot="button" className={classes} {...props} />;
  }
  return <button data-slot="button" type={type ?? "button"} className={classes} {...props} />;
}
