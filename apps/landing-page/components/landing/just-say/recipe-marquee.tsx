"use client";

import {
  RECIPE_MARQUEE_ROW_CONFIG,
  RECIPE_MARQUEE_ROWS,
  type RecipeMarqueeItem,
} from "@/lib/landing/recipe-marquee-data";
import { cn } from "@/lib/utils";

type RecipeMarqueeRowProps = {
  items: RecipeMarqueeItem[];
  duration: string;
  reverse: boolean;
  rowIndex: number;
};

function RecipeMarqueeRow({
  items,
  duration,
  reverse,
  rowIndex,
}: RecipeMarqueeRowProps) {
  const loop = [...items, ...items];

  return (
    <div className="landing-recipe-marquee-row">
      <div
        className={cn(
          "landing-recipe-marquee-track flex w-max items-center gap-2.5 px-3 md:gap-3",
          reverse && "landing-recipe-marquee-track--reverse",
        )}
        style={{ animationDuration: duration }}
      >
        {loop.map((item, index) => (
          <a
            key={`${rowIndex}-${item.slug}-${index}`}
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            className="landing-recipe-marquee-link shrink-0"
            aria-label={`${item.slug} recipe on GitHub`}
          >
            {item.slug}
          </a>
        ))}
      </div>
    </div>
  );
}

export function RecipeMarquee({ label }: { label: string }) {
  return (
    <div className="landing-recipe-marquee group/marquee w-full">
      <p className="mb-4 px-4 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground md:px-6 md:mb-5">
        {label}
      </p>

      <div className="border-y border-border bg-[linear-gradient(180deg,color-mix(in_oklch,var(--surface)_65%,var(--background))_0%,var(--background)_100%)]">
        {RECIPE_MARQUEE_ROWS.map((row, index) => (
          <RecipeMarqueeRow
            key={index}
            rowIndex={index}
            items={row}
            duration={RECIPE_MARQUEE_ROW_CONFIG[index]!.duration}
            reverse={RECIPE_MARQUEE_ROW_CONFIG[index]!.reverse}
          />
        ))}
      </div>
    </div>
  );
}
