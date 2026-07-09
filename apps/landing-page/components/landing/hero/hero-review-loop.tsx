import { StepRow } from "@/components/landing/shared/step-row";
import { StableTextBlock } from "@/components/landing/shared/stable-text-block";
import {
  LANDING_FONTS,
  LINE_HEIGHT,
  LOOP_HEADER_RESERVE,
} from "@/lib/landing/demo-reserve-text";
import type { StepStatus } from "@/lib/landing/types";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";

export type AgentNotePhase = "hidden" | "visible" | "fading";

export type ReviewLoopVisual = {
  iteration: number;
  planStatus: StepStatus;
  planDetail?: string;
  reviewStatus: StepStatus;
  reviewDetail?: string;
  agentNote?: string;
  agentNotePhase: AgentNotePhase;
  showLoopBack: boolean;
  loopComplete: boolean;
};

type HeroReviewLoopProps = {
  loop: ReviewLoopVisual;
  className?: string;
};

function reviewDetail(loop: ReviewLoopVisual) {
  if (loop.agentNotePhase !== "hidden" && loop.agentNote) {
    return loop.agentNote;
  }
  if (loop.showLoopBack) {
    return "↻ back to plan";
  }
  return loop.reviewDetail;
}

function reviewDetailClassName(loop: ReviewLoopVisual) {
  if (loop.agentNotePhase === "visible") {
    return "text-foreground/90 italic";
  }
  if (loop.agentNotePhase === "fading") {
    return "opacity-0 text-foreground/90 italic";
  }
  if (loop.showLoopBack) {
    return "text-primary";
  }
  return undefined;
}

export function HeroReviewLoop({ loop, className }: HeroReviewLoopProps) {
  const detail = reviewDetail(loop);

  return (
    <div
      className={cn(
        "rounded-md border border-dashed border-primary/20 bg-accent/10 px-2 py-2",
        className,
      )}
    >
      <StableTextBlock
        reserveText={LOOP_HEADER_RESERVE}
        font={LANDING_FONTS.mono2xs}
        lineHeight={LINE_HEIGHT.mono2xs}
        className="mb-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground"
      >
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0">
          <RefreshCw className="size-3 shrink-0 text-primary" aria-hidden />
          <span>plan · review loop</span>
          {loop.iteration > 0 && (
            <span className="normal-case text-foreground/80">· iter {loop.iteration}</span>
          )}
          {loop.loopComplete && (
            <span className="normal-case text-primary">· gate passed</span>
          )}
        </p>
      </StableTextBlock>

      <div className="space-y-1">
        <StepRow
          label="Plan"
          status={loop.planStatus}
          detail={loop.planDetail}
          detailColumn
          animate={loop.planStatus === "saved"}
        />
        <StepRow
          label="Review"
          status={loop.reviewStatus}
          detail={detail}
          detailClassName={reviewDetailClassName(loop)}
          detailColumn
          animate={loop.reviewStatus === "saved" && loop.loopComplete}
        />
      </div>
    </div>
  );
}
