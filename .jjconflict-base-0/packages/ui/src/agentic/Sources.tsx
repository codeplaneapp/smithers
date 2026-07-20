/** @jsxImportSource react */
import { useId, useState, type ComponentProps, type MouseEvent } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { safeHref } from "./safeHref";

export type SourceItem = { id: string; label: string; href?: string };

export type SourcesProps = Omit<ComponentProps<"div">, "children"> & {
  sources: readonly SourceItem[];
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

/** Text-only, collapsible attribution list for response sources. */
export function Sources({
  sources,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  onNavigate,
  className,
  ...props
}: SourcesProps) {
  useInjectUiCss();
  const bodyId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  function toggle() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  const countLabel = `Used ${sources.length} ${sources.length === 1 ? "source" : "sources"}`;

  return (
    <div
      data-slot="sources"
      data-state={open ? "open" : "closed"}
      className={cn("sui-sources", className)}
      {...props}
    >
      <button
        type="button"
        data-slot="sources-trigger"
        className="sui-sources-trigger"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
      >
        {countLabel}
      </button>
      {open ? (
        <ul data-slot="sources-list" id={bodyId} className="sui-sources-list">
          {sources.map((source) => {
            const href = source.href === undefined ? undefined : safeHref(source.href);
            return (
              <li data-slot="sources-item" className="sui-sources-item" key={source.id}>
                {href !== undefined ? (
                  <a
                    className="sui-sources-link"
                    href={href}
                    onClick={
                      onNavigate
                        ? (event) => {
                            event.preventDefault();
                            onNavigate(href, event);
                          }
                        : undefined
                    }
                  >
                    {source.label}
                  </a>
                ) : (
                  <span className="sui-sources-label">{source.label}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
