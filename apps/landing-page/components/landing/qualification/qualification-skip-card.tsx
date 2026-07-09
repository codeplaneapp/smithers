import { QualificationVisual } from "@/components/landing/qualification/qualification-visual";
import { QUALIFICATION_SKIP } from "@/lib/landing/content";
import { cn } from "@/lib/utils";
import { Minus } from "lucide-react";

type QualificationSkipCardProps = {
  inView: boolean;
};

export function QualificationSkipCard({ inView }: QualificationSkipCardProps) {
  return (
    <article
      className={cn(
        "rounded-xl border border-border bg-card/40 p-4 md:p-5",
        inView && "landing-enter landing-enter-delay-3",
      )}
    >
      <QualificationVisual type="single-shot" />

      <div className="mt-4 flex gap-2.5">
        <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          <h3 className="font-medium text-foreground">{QUALIFICATION_SKIP.title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {QUALIFICATION_SKIP.text}
          </p>
        </div>
      </div>
    </article>
  );
}
