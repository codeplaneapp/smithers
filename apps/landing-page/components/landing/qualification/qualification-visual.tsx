import type { QualificationVisualType } from "@/lib/landing/types";
import { VisualFrame } from "@/components/landing/shared/visual-frame";
import { cn } from "@/lib/utils";
import { ArrowRight, Clock, Laptop, MessageSquare, Terminal } from "lucide-react";

function MultiStepVisual() {
  const steps = ["Intake", "Work", "Verify"];

  return (
    <VisualFrame>
      <div className="landing-multi-step flex flex-wrap items-center justify-center gap-x-1 gap-y-2 sm:gap-1.5">
        {steps.map((step, index) => (
          <div key={step} className="flex items-center gap-1.5">
            <div className="landing-multi-step-signal" data-step={index}>
              <div className="landing-multi-step-node rounded-md border px-2 py-1.5 text-center font-mono text-[10px]">
                {step}
              </div>
            </div>
            {index < steps.length - 1 && (
              <div className="landing-multi-step-arrow-signal" data-after={index}>
                <ArrowRight
                  className="landing-multi-step-arrow size-3 shrink-0 text-primary"
                  aria-hidden
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="landing-multi-step-caption mt-3 text-center font-mono text-[10px] text-muted-foreground">
        ordered steps · not one blob of chat
      </p>
    </VisualFrame>
  );
}

function StepChip({
  label,
  detail,
  tone,
  spinOnHover = false,
}: {
  label: string;
  detail: string;
  tone: "saved" | "running" | "skipped" | "killed";
  spinOnHover?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px]",
        tone === "saved" && "border-primary/30 bg-accent/30 text-foreground",
        tone === "running" && "border-primary/30 bg-primary/10 text-primary",
        tone === "skipped" && "border-border bg-background/60 text-muted-foreground",
        tone === "killed" &&
          "border-destructive/35 bg-destructive/10 text-destructive",
      )}
    >
      {tone === "saved" && <span className="text-primary">✓</span>}
      {tone === "running" && (
        <span
          className={cn(
            "inline-block leading-none",
            spinOnHover && "landing-durable-resume-icon",
          )}
        >
          ↻
        </span>
      )}
      {tone === "skipped" && <span className="text-muted-foreground">–</span>}
      {tone === "killed" && <span aria-hidden>×</span>}
      <span>{label}</span>
      <span
        className={cn(
          tone === "killed" ? "text-destructive/80" : "text-muted-foreground",
        )}
      >
        · {detail}
      </span>
    </span>
  );
}

function DurableVisual() {
  return (
    <VisualFrame>
      <div className="space-y-2.5 font-mono text-[10px]">
        <div>
          <p className="mb-1.5 text-muted-foreground">Before crash</p>
          <div className="flex flex-wrap gap-1.5">
            <StepChip label="scan" detail="saved" tone="saved" />
            <StepChip label="triage" detail="saved" tone="saved" />
            <StepChip label="fix" detail="killed" tone="killed" />
          </div>
        </div>

        <p className="flex items-center gap-1 text-muted-foreground">
          <Terminal className="size-3 shrink-0" aria-hidden />
          process killed mid-fix
        </p>

        <div>
          <p className="mb-1.5 text-muted-foreground">On resume</p>
          <div className="flex flex-wrap gap-1.5">
            <StepChip label="scan" detail="skipped" tone="skipped" />
            <StepChip label="triage" detail="skipped" tone="skipped" />
            <StepChip
              label="fix"
              detail="resumed"
              tone="running"
              spinOnHover
            />
          </div>
        </div>
      </div>
    </VisualFrame>
  );
}

function ApprovalVisual() {
  return (
    <VisualFrame>
      <div className="landing-approval space-y-2">
        <div className="rounded-md border border-border bg-background/60 px-2 py-1.5 font-mono text-[10px] text-foreground">
          ✓ milestone saved
        </div>
        <div className="landing-approval-gate rounded-md border border-border bg-background/60 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
          ⏸ approve to ship · waiting for you
        </div>
        <p className="landing-approval-note flex items-center justify-center gap-1 font-mono text-[10px] text-muted-foreground">
          <Clock className="size-3" aria-hidden />
          tomorrow · no token burn
        </p>
      </div>
    </VisualFrame>
  );
}

function LongRunVisual() {
  return (
    <VisualFrame>
      <div className="landing-long-run space-y-3.5">
        <div
          className="landing-long-run-track"
          role="img"
          aria-label="Background job progress while away"
        >
          <div className="landing-long-run-shimmer" aria-hidden />
          <div className="landing-long-run-shimmer landing-long-run-shimmer--offset" aria-hidden />
          <div className="landing-long-run-fill" aria-hidden />
        </div>

        <div className="flex flex-col items-start gap-1 font-mono text-[10px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span className="landing-long-run-lid inline-flex items-center gap-1">
            <Laptop className="size-3 shrink-0" aria-hidden />
            lid closed
          </span>
          <span className="landing-long-run-elapsed text-primary">
            <span className="tabular-nums">6h</span>
            <span className="landing-long-run-elapsed-suffix"> elapsed · still running</span>
          </span>
        </div>
      </div>
    </VisualFrame>
  );
}

function SingleShotVisual() {
  return (
    <VisualFrame className="min-h-[10rem] bg-[linear-gradient(165deg,var(--background)_0%,color-mix(in_oklch,var(--surface)_90%,var(--ink-muted))_100%)] p-4">
      <div className="mx-auto flex w-full max-w-sm flex-col gap-2.5">
        <div className="rounded-lg border border-border bg-background/80 px-3 py-2.5 text-left shadow-sm">
          <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            You
          </p>
          <p className="mt-1 font-mono text-xs leading-relaxed text-foreground">
            Explain what this function does.
          </p>
        </div>
        <div className="rounded-lg border border-border/70 bg-background/50 px-3 py-2.5 text-left">
          <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            Agent
          </p>
          <p className="mt-1 font-mono text-xs leading-relaxed text-muted-foreground">
            It validates input and returns a formatted string…
          </p>
        </div>
        <p className="flex items-center justify-center gap-1.5 pt-0.5 font-mono text-[11px] text-muted-foreground">
          <MessageSquare className="size-3.5 shrink-0" aria-hidden />
          one exchange · done
        </p>
      </div>
    </VisualFrame>
  );
}

const visuals: Record<QualificationVisualType, () => React.ReactElement> = {
  "multi-step": MultiStepVisual,
  durable: DurableVisual,
  approval: ApprovalVisual,
  "long-run": LongRunVisual,
  "single-shot": SingleShotVisual,
};

export function QualificationVisual({ type }: { type: QualificationVisualType }) {
  const Visual = visuals[type];
  return <Visual />;
}
