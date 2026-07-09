import { cn } from "@/lib/utils";

type VisualFrameProps = {
  children: React.ReactNode;
  className?: string;
};

export function VisualFrame({ children, className }: VisualFrameProps) {
  return (
    <div
      className={cn(
        "relative flex min-h-[8.5rem] flex-col justify-center overflow-hidden rounded-lg border border-border/80 bg-[linear-gradient(165deg,color-mix(in_oklch,var(--surface)_92%,var(--gold))_0%,var(--background)_55%)] p-3",
        className,
      )}
    >
      {children}
    </div>
  );
}
