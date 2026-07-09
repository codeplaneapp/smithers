"use client";

import { HarnessPills } from "@/components/landing/qualification/harness-pills";
import { QualificationSkipCard } from "@/components/landing/qualification/qualification-skip-card";
import { QualificationUseCard } from "@/components/landing/qualification/qualification-use-card";
import { SectionHeading } from "@/components/landing/shared/section-heading";
import { SectionLabel } from "@/components/landing/shared/section-label";
import { SectionShell } from "@/components/landing/shared/section-shell";
import {
  QUALIFICATION_BRIDGE,
  QUALIFICATION_SKIP,
  QUALIFICATION_USE_CASES,
} from "@/lib/landing/content";
import { cn } from "@/lib/utils";
import { useInView } from "@/lib/landing/hooks";

export function QualificationSection() {
  const { ref, inView } = useInView<HTMLElement>();

  return (
    <SectionShell ref={ref}>
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          label="Is this for you?"
          title="Is Smithers for you?"
          description={QUALIFICATION_BRIDGE}
          className="max-w-3xl"
        />

        <div className="mt-8 grid gap-4 sm:mt-10 sm:grid-cols-2">
          {QUALIFICATION_USE_CASES.map((useCase, index) => (
            <QualificationUseCard key={useCase.id} {...useCase} inView={inView} index={index} />
          ))}
        </div>

        <div className="mt-10 border-t border-border/80 pt-8 sm:mt-12 sm:pt-10 md:pt-12">
          <div
            className={cn(
              "max-w-2xl",
              inView && "landing-enter landing-enter-delay-2",
            )}
          >
            <SectionLabel>{QUALIFICATION_SKIP.label}</SectionLabel>
            <h2 className="mt-3 font-display text-xl tracking-tight text-foreground sm:text-2xl md:text-3xl">
              {QUALIFICATION_SKIP.heading}
            </h2>
          </div>

          <div className="mt-6">
            <QualificationSkipCard inView={inView} />
          </div>
        </div>

        <HarnessPills />
      </div>
    </SectionShell>
  );
}
