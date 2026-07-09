"use client";

import {
  HeroReviewLoop,
  type ReviewLoopVisual,
} from "@/components/landing/hero/hero-review-loop";
import { StepRow } from "@/components/landing/shared/step-row";
import { StableTextBlock } from "@/components/landing/shared/stable-text-block";
import {
  LANDING_FONTS,
  LINE_HEIGHT,
  RUN_FOOTER_RESERVE,
} from "@/lib/landing/demo-reserve-text";
import type { StepStatus } from "@/lib/landing/types";
import { CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";

type DemoFrame = {
  scope: StepStatus;
  loop: ReviewLoopVisual;
  ship: StepStatus;
  shipDetail?: string;
  showGatePassed: boolean;
};

const emptyLoop = (): ReviewLoopVisual => ({
  iteration: 0,
  planStatus: "pending",
  reviewStatus: "pending",
  agentNotePhase: "hidden",
  showLoopBack: false,
  loopComplete: false,
});

const initial: DemoFrame = {
  scope: "pending",
  loop: emptyLoop(),
  ship: "pending",
  showGatePassed: false,
};

type HeroDemoRunProps = {
  active: boolean;
};

export function HeroDemoRun({ active }: HeroDemoRunProps) {
  const [frame, setFrame] = useState<DemoFrame>(initial);

  useEffect(() => {
    if (!active) {
      return;
    }

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const schedule = (fn: () => void, ms: number) => {
      timers.push(setTimeout(fn, ms));
    };

    const run = () => {
      if (cancelled) return;
      setFrame(initial);

      schedule(() => setFrame((f) => ({ ...f, scope: "saved" })), 700);

      schedule(
        () =>
          setFrame((f) => ({
            ...f,
            loop: { ...emptyLoop(), iteration: 1, planStatus: "running" },
          })),
        1400,
      );
      schedule(
        () =>
          setFrame((f) => ({
            ...f,
            loop: { ...f.loop, planStatus: "saved", planDetail: "iter 1" },
          })),
        2400,
      );
      schedule(
        () =>
          setFrame((f) => ({
            ...f,
            loop: {
              ...f.loop,
              reviewStatus: "running",
              planDetail: "iter 1",
            },
          })),
        3200,
      );
      schedule(
        () =>
          setFrame((f) => ({
            ...f,
            loop: {
              ...f.loop,
              reviewStatus: "retry",
              agentNote: "This needs to improve",
              agentNotePhase: "visible",
            },
          })),
        4200,
      );
      schedule(
        () =>
          setFrame((f) => ({
            ...f,
            loop: { ...f.loop, agentNotePhase: "fading" },
          })),
        5200,
      );
      schedule(
        () =>
          setFrame((f) => ({
            ...f,
            loop: {
              ...f.loop,
              agentNote: undefined,
              agentNotePhase: "hidden",
              showLoopBack: true,
              reviewStatus: "pending",
              iteration: 2,
            },
          })),
        5700,
      );
      schedule(
        () =>
          setFrame((f) => ({
            ...f,
            loop: {
              ...f.loop,
              planStatus: "running",
              planDetail: "iter 2",
              showLoopBack: false,
            },
          })),
        5800,
      );
      schedule(
        () =>
          setFrame((f) => ({
            ...f,
            loop: {
              ...f.loop,
              planStatus: "saved",
              planDetail: "iter 2",
            },
          })),
        6800,
      );
      schedule(
        () =>
          setFrame((f) => ({
            ...f,
            loop: { ...f.loop, reviewStatus: "running" },
          })),
        7600,
      );
      schedule(
        () =>
          setFrame((f) => ({
            ...f,
            loop: {
              ...f.loop,
              reviewStatus: "saved",
              reviewDetail: "passed",
              loopComplete: true,
            },
          })),
        8600,
      );
      schedule(
        () =>
          setFrame((f) => ({
            ...f,
            ship: "running",
            shipDetail: "in progress",
            showGatePassed: true,
          })),
        9600,
      );

      schedule(run, 18000);
    };

    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [active]);

  return (
    <div className="space-y-2">
      <StepRow
        label="Scope"
        status={frame.scope}
        detail={frame.scope === "saved" ? "saved" : undefined}
        detailColumn
        animate={frame.scope === "saved"}
      />

      <HeroReviewLoop loop={frame.loop} />

      <StepRow
        label="Ship"
        status={frame.ship}
        detail={frame.shipDetail}
        detailColumn
      />

      <StableTextBlock
        reserveText={RUN_FOOTER_RESERVE}
        font={LANDING_FONTS.mono2xs}
        lineHeight={LINE_HEIGHT.mono2xs}
      >
        {frame.showGatePassed && (
          <p className="flex items-center gap-1.5 pt-1 font-mono text-[10px] text-primary">
            <CircleCheck className="size-3 shrink-0" aria-hidden />
            Review gate passed — run continues
          </p>
        )}
      </StableTextBlock>
    </div>
  );
}
