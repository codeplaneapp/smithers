import { QualificationVisual } from "@/components/landing/qualification/qualification-visual";
import type { QualificationUseCase } from "@/lib/landing/types";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

type QualificationUseCardProps = QualificationUseCase & {
  inView: boolean;
  index: number;
};

export function QualificationUseCard({
  title,
  text,
  visual,
  inView,
  index,
}: QualificationUseCardProps) {
  return (
    <article
      className={cn(
        "landing-qual-card group/card flex h-full flex-col rounded-xl border border-border bg-card p-4 transition-[border-color] duration-200 ease-out hover:border-primary/25 md:p-5",
        inView && "landing-enter",
      )}
      style={inView ? { animationDelay: `${index * 70}ms` } : undefined}
    >
      <QualificationVisual type={visual} />
      <div className="mt-4 flex gap-2.5">
        <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div>
          <h3 className="font-medium text-foreground">{title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{text}</p>
        </div>
      </div>
    </article>
  );
}
