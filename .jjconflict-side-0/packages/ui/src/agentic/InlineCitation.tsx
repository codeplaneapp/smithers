/** @jsxImportSource react */
import type { ComponentProps, MouseEvent } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip";
import { safeHref } from "./safeHref";

export type InlineCitationProps = Omit<ComponentProps<"a">, "href" | "children" | "onClick"> & {
  index: number;
  label: string;
  href?: string;
  onNavigate?: (
    href: string,
    event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
  ) => void;
};

/** Focusable superscript citation with a source-label tooltip. */
export function InlineCitation({
  index,
  label,
  href: rawHref,
  onNavigate,
  className,
  ...props
}: InlineCitationProps) {
  useInjectUiCss();
  const href = rawHref === undefined ? undefined : safeHref(rawHref);
  const accessibleName = `Source ${index}: ${label}`;

  return (
    <sup data-slot="inline-citation" className={cn("sui-citation", className)}>
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            {href !== undefined ? (
              <a
                {...props}
                href={href}
                aria-label={accessibleName}
                onClick={
                  onNavigate
                    ? (event) => {
                        event.preventDefault();
                        onNavigate(href, event);
                      }
                    : undefined
                }
              >
                [{index}]
              </a>
            ) : (
              <button
                {...(props as ComponentProps<"button">)}
                type="button"
                aria-label={accessibleName}
              >
                [{index}]
              </button>
            )}
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </sup>
  );
}
