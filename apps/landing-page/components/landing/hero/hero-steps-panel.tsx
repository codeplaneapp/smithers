"use client";

import { StepRow } from "@/components/landing/shared/step-row";
import { StableTextBlock } from "@/components/landing/shared/stable-text-block";
import {
  LANDING_FONTS,
  LINE_HEIGHT,
  STEPS_PANEL_RESERVE,
} from "@/lib/landing/demo-reserve-text";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

const MILESTONES = [
  "Milestone 1 — audit routes",
  "Milestone 2 — swap client",
  "Milestone 3 — e2e tests",
] as const;

type ApprovalState = "hidden" | "waiting" | "approved";

type HeroStepsPanelProps = {
  visible: boolean;
  milestonesVisible: number;
  approvalState: ApprovalState;
  onApprove: () => void;
};

export function HeroStepsPanel({
  visible,
  milestonesVisible,
  approvalState,
  onApprove,
}: HeroStepsPanelProps) {
  const approved = approvalState === "approved";

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-background/40 p-3 transition-opacity duration-300 sm:p-4",
        visible ? "opacity-100" : "opacity-40",
      )}
    >
      <StableTextBlock
        reserveText={STEPS_PANEL_RESERVE}
        font={LANDING_FONTS.monoXs}
        lineHeight={LINE_HEIGHT.monoXs}
      >
        {!visible ? (
          <p className="font-mono text-xs text-muted-foreground">
            Steps appear when your agent starts a run…
          </p>
        ) : approved ? (
          <div className="space-y-1">
            <StepRow
              label="Milestones approved"
              status="saved"
              detail="approved"
              animate
            />
            <StepRow
              label={MILESTONES[0]}
              status="running"
              detail="in progress"
            />
            {MILESTONES.slice(1).map((label) => (
              <StepRow key={label} label={label} status="pending" />
            ))}
            <p className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[10px] leading-snug text-primary sm:mt-3">
              <Loader2 className="size-3 shrink-0 landing-spin" aria-hidden />
              Agent working milestone 1 — each step saves as it completes
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {MILESTONES.map((label, index) =>
              index < milestonesVisible ? (
                <StepRow key={label} label={label} status="pending" />
              ) : null,
            )}
            {approvalState === "waiting" && (
              <button
                type="button"
                onClick={onApprove}
                className="group w-full rounded-md text-left transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <StepRow
                  label="Waiting for your OK on milestones"
                  status="waiting"
                  detail="click to approve"
                  className="cursor-pointer"
                />
              </button>
            )}
          </div>
        )}
      </StableTextBlock>
    </div>
  );
}
