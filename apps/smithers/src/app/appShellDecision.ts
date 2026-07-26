import type { Layout } from "./preferencesStore";
import type { View } from "./routeStore";
import type { Surface } from "./Surface";

export type AppShellMode = "home" | "chat" | "sidebar" | "gate";
export type PairFrameMode = "none" | "gate" | "workspace";

export type AppShellDecisionInput = {
  layout: Layout;
  view: View;
  surface: Surface | null;
  messagesCount: number;
  pathname: string;
  pairKeyPresent: boolean;
};

export type AppShellDecision = {
  onPair: boolean;
  pairFrame: PairFrameMode;
  effectiveLayout: Layout;
  isChat: boolean;
  mode: AppShellMode;
  showTranscript: boolean;
  canvasKey: string;
};

function canvasKeyFor(view: View, surface: Surface | null): string {
  if (!surface) return view;
  return `${surface.kind}-${"runId" in surface ? surface.runId : ""}`;
}

export function deriveAppShellDecision({
  layout,
  view,
  surface,
  messagesCount,
  pathname,
  pairKeyPresent,
}: AppShellDecisionInput): AppShellDecision {
  const onPair = pathname.startsWith("/pair");
  const pairFrame: PairFrameMode = onPair ? (pairKeyPresent ? "workspace" : "gate") : "none";
  const effectiveLayout = surface ? "sidebar" : layout;
  const isChat = messagesCount > 0 || view !== "home" || surface !== null;
  const mode = onPair
    ? pairKeyPresent
      ? "sidebar"
      : "gate"
    : effectiveLayout === "sidebar"
      ? "sidebar"
      : isChat
        ? "chat"
        : "home";
  const showTranscript = !onPair && surface === null && view !== "store" && messagesCount > 0;
  const canvasKey = onPair ? "pair" : canvasKeyFor(view, surface);

  return {
    onPair,
    pairFrame,
    effectiveLayout,
    isChat,
    mode,
    showTranscript,
    canvasKey,
  };
}
