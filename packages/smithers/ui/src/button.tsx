/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "./cn";
import { Spinner } from "./spinner";
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
    /**
     * Render a Spinner before the children, mark the button `aria-busy`, and
     * disable interaction while work is in flight. Under `asChild`, disabled,
     * busy, and aria-disabled semantics are forwarded but no Spinner is
     * injected (the Slot cannot inject one into an arbitrary child element).
     */
    loading?: boolean;
  };

/**
 * Button with shadcn variant anatomy on the Smithers theme tokens.
 *
 * `variant="default"` reproduces the house tinted-brand primary
 * (`.button.primary` in the styleguide) for visual continuity; use
 * `variant="solid"` for shadcn's filled look. Defaults `type="button"` so
 * buttons inside forms never submit accidentally.
 */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  type,
  disabled,
  children,
  ...props
}: ButtonProps) {
  useInjectUiCss();
  const classes = cn(buttonVariants({ variant, size }), className);
  const interactionDisabled = disabled || loading;
  if (asChild) {
    // Slot.Root's public type only declares generic HTML attributes, but it
    // merges arbitrary child props at runtime. Keep `disabled` in a spread so
    // slotted native controls receive the real disabling attribute rather
    // than only advisory aria-disabled state.
    const slottedStateProps = {
      disabled: interactionDisabled || undefined,
      "aria-disabled": interactionDisabled ? true : undefined,
      "aria-busy": loading ? true : undefined,
    };
    return (
      <Slot.Root data-slot="button" className={classes} {...slottedStateProps} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      data-slot="button"
      type={type ?? "button"}
      className={classes}
      disabled={interactionDisabled}
      aria-busy={loading ? true : undefined}
      {...props}
    >
      {loading ? <Spinner size="sm" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
