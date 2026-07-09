"use client";

import { HeroDemoRun } from "@/components/landing/hero/hero-demo-run";
import { HeroDemoTalk } from "@/components/landing/hero/hero-demo-talk";
import { RunShell } from "@/components/landing/shared/run-shell";
import { useStableTextHeights } from "@/lib/landing/text-measure";
import {
  LANDING_FONTS,
  LINE_HEIGHT,
  RUN_SHELL_RESERVE,
  TALK_SHELL_RESERVE,
} from "@/lib/landing/demo-reserve-text";
import { HERO_TABS } from "@/lib/landing/content";
import type { HeroTabId } from "@/lib/landing/types";
import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";

const DEMO_FOOTER =
  "You don't write workflows. You ask. Your agent picks the recipe.";

export function HeroDemoTabs() {
  const [tab, setTab] = useState<HeroTabId>("talk");
  const activeTab = HERO_TABS.find((t) => t.id === tab);
  const reserveTexts = useMemo(() => [TALK_SHELL_RESERVE, RUN_SHELL_RESERVE], []);
  const { ref, minHeight } = useStableTextHeights(
    reserveTexts,
    LANDING_FONTS.monoXs,
    LINE_HEIGHT.monoXs,
  );

  return (
    <div className="mx-auto mt-8 max-w-4xl sm:mt-12">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex w-full gap-1 rounded-lg border border-border bg-card p-1 sm:w-auto">
          {HERO_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "flex-1 rounded-md px-2 py-2 text-center text-xs transition-colors duration-200 sm:flex-none sm:px-3 sm:py-1.5 sm:text-left sm:text-sm",
                tab === t.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="hidden font-mono text-[10px] text-muted-foreground sm:block">
          {activeTab?.hint}
        </p>
      </div>

      <div
        ref={ref}
        className="grid grid-cols-1 grid-rows-1"
        style={{ minHeight: minHeight ?? undefined }}
      >
        <div
          className={cn(
            "col-start-1 row-start-1 transition-opacity duration-200",
            tab === "talk" ? "z-10 opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <RunShell className="shadow-lg shadow-black/25">
            <HeroDemoTalk key={tab === "talk" ? "on" : "off"} active={tab === "talk"} />
            <p className="mt-4 border-t border-border pt-4 text-center text-xs text-muted-foreground">
              {DEMO_FOOTER}
            </p>
          </RunShell>
        </div>
        <div
          className={cn(
            "col-start-1 row-start-1 transition-opacity duration-200",
            tab === "run" ? "z-10 opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <RunShell className="shadow-lg shadow-black/25">
            <HeroDemoRun key={tab === "run" ? "on" : "off"} active={tab === "run"} />
            <p className="mt-4 border-t border-border pt-4 text-center text-xs text-muted-foreground">
              {DEMO_FOOTER}
            </p>
          </RunShell>
        </div>
      </div>

      <p className="mt-3 text-center text-xs text-muted-foreground sm:mt-4 sm:text-sm">
        Real Smithers runs look like this — structured steps, not a wall of chat text.
      </p>
    </div>
  );
}
