import {
  CHAT_AGENTS_RESERVE,
  CHAT_USER_RESERVE,
  LANDING_FONTS,
  LINE_HEIGHT,
} from "@/lib/landing/demo-reserve-text";
import { StableTextBlock } from "@/components/landing/shared/stable-text-block";

type HeroChatPanelProps = {
  typed: string;
  showAgent: boolean;
  isTyping: boolean;
  planApproved?: boolean;
};

export function HeroChatPanel({
  typed,
  showAgent,
  isTyping,
  planApproved = false,
}: HeroChatPanelProps) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3 sm:p-4">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        Codex · you
      </p>
      <div className="space-y-3 font-mono text-xs leading-relaxed">
        <StableTextBlock
          reserveText={CHAT_USER_RESERVE}
          font={LANDING_FONTS.monoXs}
          lineHeight={LINE_HEIGHT.monoXs}
        >
          <div>
            <span className="text-muted-foreground">You:</span>
            <p className="mt-1 text-foreground">
              {typed}
              {isTyping && (
                <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-primary" />
              )}
            </p>
          </div>
        </StableTextBlock>

        <StableTextBlock
          reserveText={CHAT_AGENTS_RESERVE}
          font={LANDING_FONTS.monoXs}
          lineHeight={LINE_HEIGHT.monoXs}
        >
          {planApproved ? (
            <div>
              <span className="text-muted-foreground">Agent:</span>
              <p className="mt-1 text-foreground">
                Review passed — applying the change.
              </p>
            </div>
          ) : showAgent ? (
            <div>
              <span className="text-muted-foreground">Agent:</span>
              <p className="mt-1 text-foreground">
                Starting the implement recipe in Smithers…
              </p>
            </div>
          ) : null}
        </StableTextBlock>
      </div>
    </div>
  );
}
