import type { WhyDemoType } from "@/lib/landing/types";
import { VisualFrame } from "@/components/landing/shared/visual-frame";
import { ArrowRight, GitBranch, Wrench } from "lucide-react";
import { Fragment } from "react";

function MultiAgentVisual() {
  const steps = ["Plan", "Review", "Implement"];

  return (
    <VisualFrame>
      <div className="flex items-center justify-center gap-2">
        {steps.map((step, index) => (
          <Fragment key={step}>
            <span className="rounded border border-border bg-background/60 px-2 py-1 font-mono text-[10px] text-foreground">
              {step}
            </span>
            {index < steps.length - 1 && (
              <ArrowRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
            )}
          </Fragment>
        ))}
      </div>
    </VisualFrame>
  );
}

function ExpertiseVisual() {
  const rules = [
    "gateway API patterns only",
    "match OpenAPI spec",
    "no direct DB writes",
  ];

  return (
    <VisualFrame>
      <div className="mx-auto w-full max-w-[15rem] space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          migrate-dashboard · recipe
        </p>
        <div className="rounded-md border border-primary/25 bg-background/50 px-2.5 py-2">
          <p className="font-mono text-[10px] text-primary">your rules</p>
          <ul className="mt-1.5 space-y-1">
            {rules.map((rule) => (
              <li
                key={rule}
                className="flex items-start gap-1.5 font-mono text-[10px] leading-snug text-foreground"
              >
                <span className="text-primary" aria-hidden>
                  ▸
                </span>
                {rule}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-center font-mono text-[10px] text-muted-foreground">
          encoded once · runs every time
        </p>
      </div>
    </VisualFrame>
  );
}

function SystemVisual() {
  return (
    <VisualFrame className="min-h-[9rem]">
      <div className="group mx-auto w-full max-w-[16rem] space-y-2.5">
        <div className="rounded-md border border-border/80 bg-background/40 px-2.5 py-2 opacity-60">
          <p className="font-mono text-[10px] text-muted-foreground">chat fix</p>
          <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted-foreground line-through decoration-destructive/50">
            rewrite the paragraph again…
          </p>
        </div>
        <div className="rounded-md border border-primary/30 bg-accent/20 px-2.5 py-2 transition-colors group-hover:border-primary/45">
          <p className="flex items-center gap-1 font-mono text-[10px] text-primary">
            <Wrench className="size-3 shrink-0" aria-hidden />
            smithers fix
          </p>
          <p className="mt-1 flex items-start gap-1.5 font-mono text-[10px] leading-relaxed text-foreground">
            <GitBranch className="mt-0.5 size-3 shrink-0 text-primary" aria-hidden />
            add schema check to verify step · recipe v4
          </p>
        </div>
      </div>
    </VisualFrame>
  );
}

const visuals: Record<WhyDemoType, () => React.ReactElement> = {
  "multi-agent": MultiAgentVisual,
  expertise: ExpertiseVisual,
  system: SystemVisual,
};

export function WhyDemo({ type }: { type: WhyDemoType }) {
  const Visual = visuals[type];
  return <Visual />;
}
