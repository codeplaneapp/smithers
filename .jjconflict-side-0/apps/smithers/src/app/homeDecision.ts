import type { Layout } from "./preferencesStore";

export type HomePageContent = "hero" | "transcript" | "workflow-store";

export type HomePageDecision = {
  content: HomePageContent;
  showPairLauncher: boolean;
};

export function deriveHomePageDecision({
  layout,
  hasMessages,
}: {
  layout: Layout;
  hasMessages: boolean;
}): HomePageDecision {
  if (layout === "sidebar") {
    return { content: "workflow-store", showPairLauncher: true };
  }
  if (hasMessages) {
    return { content: "transcript", showPairLauncher: false };
  }
  return { content: "hero", showPairLauncher: true };
}
