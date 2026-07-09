import { StepRow } from "@/components/landing/shared/step-row";
import type { JustSayPrompt } from "@/lib/landing/types";

type RecipeWorkflowPreviewProps = Pick<
  JustSayPrompt,
  "recipe" | "recipeSummary" | "steps"
>;

export function RecipeWorkflowPreview({
  recipe,
  recipeSummary,
  steps,
}: RecipeWorkflowPreviewProps) {
  return (
    <div className="border border-border/80 bg-background/40 p-3 sm:p-4">
      <p className="text-sm leading-relaxed text-muted-foreground">{recipeSummary}</p>
      <p className="mt-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
        Your agent picks the{" "}
        <span className="text-primary">{recipe}</span> recipe — you didn&apos;t name it.
      </p>

      <div className="mt-4 space-y-1 border-t border-border/70 pt-4">
        {steps.map((step) => (
          <StepRow
            key={step.label}
            label={step.label}
            status={step.status ?? "pending"}
            detail={step.detail}
            detailColumn={Boolean(step.detail)}
          />
        ))}
      </div>
    </div>
  );
}
