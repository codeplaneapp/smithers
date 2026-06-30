import { createRoute } from "@tanstack/react-router";
import { useChatStore } from "../chat/chatStore";
import { WorkflowStore } from "../store/WorkflowStore";
import { deriveHomePageDecision } from "./homeDecision";
import { usePreferencesStore } from "./preferencesStore";
import { rootRoute } from "./rootRoute";

/**
 * The home page (`/`). In the centered shell it shows the hero until the first
 * message, then yields to the chat transcript (chrome). In the sidebar shell the
 * canvas defaults to the workflow store.
 */
function HomePage() {
  const layout = usePreferencesStore((state) => state.layout);
  const hasMessages = useChatStore((state) => state.messages.length > 0);
  const decision = deriveHomePageDecision({ layout, hasMessages });
  if (decision.content === "workflow-store") {
    return <WorkflowStore />;
  }
  if (decision.content === "transcript") {
    return null;
  }
  return <h1 className="composer-title">How can I help you?</h1>;
}

export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
