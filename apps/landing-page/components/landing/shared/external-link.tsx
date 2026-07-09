import { cn } from "@/lib/utils";
import { ExternalLink as ExternalLinkIcon } from "lucide-react";

type ExternalLinkProps = React.ComponentProps<"a"> & {
  iconClassName?: string;
};

export function ExternalLink({
  children,
  className,
  iconClassName,
  target = "_blank",
  rel = "noopener noreferrer",
  ...props
}: ExternalLinkProps) {
  return (
    <a
      target={target}
      rel={rel}
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    >
      {children}
      <ExternalLinkIcon
        className={cn("size-3 shrink-0", iconClassName)}
        aria-hidden
      />
    </a>
  );
}
