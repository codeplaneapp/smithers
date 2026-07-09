"use client";

import { HeroChatPanel } from "@/components/landing/hero/hero-chat-panel";
import { HeroStepsPanel } from "@/components/landing/hero/hero-steps-panel";
import { EXAMPLE_PROMPT } from "@/lib/landing/constants";
import { useInView } from "@/lib/landing/hooks";
import { useCallback, useEffect, useRef, useState } from "react";

type ApprovalState = "hidden" | "waiting" | "approved";

type HeroDemoTalkProps = {
  active: boolean;
};

export function HeroDemoTalk({ active }: HeroDemoTalkProps) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const [typed, setTyped] = useState("");
  const [showAgent, setShowAgent] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const [milestonesVisible, setMilestonesVisible] = useState(0);
  const [approvalState, setApprovalState] = useState<ApprovalState>("hidden");
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    timersRef.current.push(setTimeout(fn, ms));
  }, []);

  const resetDemo = useCallback(() => {
    setTyped("");
    setShowAgent(false);
    setShowSteps(false);
    setMilestonesVisible(0);
    setApprovalState("hidden");
  }, []);

  const startSequence = useCallback(() => {
    clearTimers();
    resetDemo();

    let i = 0;
    const typeChar = () => {
      i += 1;
      setTyped(EXAMPLE_PROMPT.slice(0, i));
      if (i < EXAMPLE_PROMPT.length) {
        schedule(typeChar, 18);
      } else {
        schedule(() => setShowAgent(true), 400);
        schedule(() => setShowSteps(true), 900);
        schedule(() => setMilestonesVisible(1), 1400);
        schedule(() => setMilestonesVisible(2), 2300);
        schedule(() => setMilestonesVisible(3), 3200);
        schedule(() => setApprovalState("waiting"), 4200);
      }
    };
    typeChar();
  }, [clearTimers, resetDemo, schedule]);

  const handleApprove = useCallback(() => {
    if (approvalState !== "waiting") return;
    setApprovalState("approved");
    clearTimers();
    schedule(startSequence, 12000);
  }, [approvalState, clearTimers, schedule, startSequence]);

  useEffect(() => {
    if (!active || !inView) {
      clearTimers();
      return;
    }

    const startTimer = setTimeout(() => startSequence(), 0);
    return () => {
      clearTimeout(startTimer);
      clearTimers();
    };
  }, [active, inView, clearTimers, startSequence]);

  return (
    <div ref={ref} className="grid h-full gap-3 sm:gap-4 md:grid-cols-2 md:items-stretch">
      <HeroChatPanel
        typed={typed}
        showAgent={showAgent}
        isTyping={typed.length > 0 && typed.length < EXAMPLE_PROMPT.length}
        planApproved={approvalState === "approved"}
      />
      <HeroStepsPanel
        visible={showSteps}
        milestonesVisible={milestonesVisible}
        approvalState={approvalState}
        onApprove={handleApprove}
      />
    </div>
  );
}
