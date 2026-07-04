import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

/** The 5x-duplicated uppercase overline label. */
export function Eyebrow({ className, ...props }: ComponentProps<"span">) {
  useInjectUiCss();
  return <span data-slot="eyebrow" className={cn("sui-eyebrow", className)} {...props} />;
}

export type SectionHeaderProps = ComponentProps<"div"> & {
  title: ReactNode;
  /** Uppercase overline above the title. */
  eyebrow?: ReactNode;
  /** Right-aligned actions slot (buttons, badges). */
  actions?: ReactNode;
};

/** Section heading row: eyebrow + title on the left, actions on the right. */
export function SectionHeader({ title, eyebrow, actions, className, children, ...props }: SectionHeaderProps) {
  useInjectUiCss();
  return (
    <div data-slot="section-header" className={cn("sui-section-header", className)} {...props}>
      <div className="sui-section-header-main">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <div className="sui-section-header-title">{title}</div>
        {children}
      </div>
      {actions ? <div className="sui-section-header-actions">{actions}</div> : null}
    </div>
  );
}
