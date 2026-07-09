import { DOC_LINK_CARDS } from "@/lib/landing/content";
import { cn } from "@/lib/utils";
import { ArrowRight, ExternalLink } from "lucide-react";

type DocLinkCardsProps = {
  className?: string;
};

export function DocLinkCards({ className }: DocLinkCardsProps) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2", className)}>
      {DOC_LINK_CARDS.map((card) => (
        <a
          key={card.href}
          href={card.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "group relative flex flex-col rounded-xl border p-5 text-left transition-colors",
            card.recommended
              ? "border-primary/30 bg-accent/10 hover:border-primary/50"
              : "border-border bg-card hover:border-primary/25",
          )}
        >
          {card.recommended && (
            <span className="mb-3 inline-flex w-fit rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary">
              Recommended
            </span>
          )}

          <p className="font-medium text-foreground">{card.title}</p>
          <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">
            {card.description}
          </p>

          <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
            {card.cta}
            {card.recommended ? (
              <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
            ) : (
              <ExternalLink className="size-3.5" aria-hidden />
            )}
          </span>
        </a>
      ))}
    </div>
  );
}
