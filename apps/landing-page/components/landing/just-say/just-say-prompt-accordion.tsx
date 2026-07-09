"use client";

import { RecipeWorkflowPreview } from "@/components/landing/just-say/recipe-workflow-preview";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { JUST_SAY_PROMPTS } from "@/lib/landing/content";

export function JustSayPromptAccordion() {
  return (
    <Accordion type="single" collapsible className="w-full">
      {JUST_SAY_PROMPTS.map((item) => (
        <AccordionItem key={item.id} value={item.id} className="border-border">
          <AccordionTrigger className="items-center gap-2 py-2.5 hover:no-underline sm:gap-3 sm:py-3 [&>svg]:mt-0">
            <span className="min-w-0 flex-1 border border-border bg-background/40 px-2.5 py-2 text-left font-mono text-[11px] leading-relaxed text-foreground sm:px-3 sm:py-2.5 sm:text-xs">
              &ldquo;{item.prompt}&rdquo;
            </span>
          </AccordionTrigger>
          <AccordionContent className="pb-1 pt-1">
            <RecipeWorkflowPreview
              recipe={item.recipe}
              recipeSummary={item.recipeSummary}
              steps={item.steps}
            />
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
