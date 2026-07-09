"use client";

import { HOW_IT_WORKS_PIPELINE } from "@/lib/landing/content";
import { useInView } from "@/lib/landing/hooks";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";

export function ArchitectureFlow() {
  const { ref, inView } = useInView<HTMLDivElement>();
  const [activeStep, setActiveStep] = useState(-1);
  const displayStep = inView ? activeStep : -1;

  useEffect(() => {
    if (!inView) {
      return;
    }

    const timers = HOW_IT_WORKS_PIPELINE.map((_, index) =>
      setTimeout(() => setActiveStep(index), index * 180),
    );
    return () => timers.forEach(clearTimeout);
  }, [inView]);

  return (
    <div ref={ref} className="mt-8 sm:mt-10">
      <div className="flex flex-col items-stretch gap-2 lg:flex-row lg:items-center lg:justify-center lg:gap-3">
        {HOW_IT_WORKS_PIPELINE.map((node, index) => (
          <div
            key={node.label}
            className="flex flex-col items-stretch gap-2 lg:flex-row lg:items-center lg:gap-3"
          >
            <div
              className={cn(
                "relative rounded-lg border border-border bg-card px-4 py-3 transition-all duration-300 lg:min-w-[10.5rem]",
                node.highlight && "border-l-2 border-l-primary",
                displayStep >= index && node.highlight && "landing-persist",
              )}
            >
              {displayStep === index && (
                <span className="absolute -left-1 top-1/2 hidden size-2 -translate-y-1/2 rounded-full bg-primary lg:block" />
              )}
              <p className="font-mono text-xs font-medium text-foreground">{node.label}</p>
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{node.detail}</p>
              {node.caption && (
                <p className="mt-1 text-[10px] text-muted-foreground/80">{node.caption}</p>
              )}
            </div>

            {index < HOW_IT_WORKS_PIPELINE.length - 1 && (
              <>
                <ArrowDown
                  className="mx-auto size-4 shrink-0 text-muted-foreground lg:hidden"
                  aria-hidden
                />
                <ArrowRight
                  className="hidden size-4 shrink-0 text-muted-foreground lg:block"
                  aria-hidden
                />
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
