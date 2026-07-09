import { JustSayPromptAccordion } from "@/components/landing/just-say/just-say-prompt-accordion";
import { RecipeMarquee } from "@/components/landing/just-say/recipe-marquee";
import { SectionHeading } from "@/components/landing/shared/section-heading";
import { SectionLabel } from "@/components/landing/shared/section-label";
import { SectionShell } from "@/components/landing/shared/section-shell";
import { JUST_SAY_SECTION } from "@/lib/landing/content";
import { LINKS } from "@/lib/landing/constants";
import { ExternalLink } from "lucide-react";

export function JustSaySection() {
  return (
    <SectionShell className="py-12 sm:py-16">
      <div className="mx-auto max-w-4xl">
        <SectionHeading
          label={JUST_SAY_SECTION.label}
          title={JUST_SAY_SECTION.title}
          description={JUST_SAY_SECTION.description}
          className="max-w-3xl [&_h2]:text-2xl [&_h2]:md:text-3xl"
        />

        <div className="-mx-4 mt-8 sm:mt-10 md:-mx-6">
          <RecipeMarquee label={JUST_SAY_SECTION.marqueeLabel} />
        </div>

        <div className="mt-8 sm:mt-12">
          <SectionLabel>{JUST_SAY_SECTION.examplesLabel}</SectionLabel>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {JUST_SAY_SECTION.examplesHint}
          </p>

          <div className="mt-4 border border-border bg-card/50 p-2 sm:mt-5 sm:p-3 md:p-4">
            <JustSayPromptAccordion />
          </div>
        </div>

        <p className="mt-6 text-sm text-muted-foreground">
          <a
            href={LINKS.workflows}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-primary"
          >
            Full workflow catalog on smithers.sh
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          </a>
        </p>
      </div>
    </SectionShell>
  );
}
