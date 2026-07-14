import { createRoute } from "@tanstack/react-router";
import { useChatStore } from "../chat/chatStore";
import { WorkflowStore } from "../store/WorkflowStore";
import { deriveHomePageDecision } from "./homeDecision";
import { usePreferencesStore } from "./preferencesStore";
import { rootRoute } from "./rootRoute";
import { SmithersMark } from "./SmithersMark";
import { goToView } from "./navigation";

const starterPrompts = [
  { label: "Ship a feature", prompt: "ship a feature that " },
  { label: "Review my code", prompt: "Review my code for " },
  { label: "Run a workflow", prompt: "Run a workflow that " },
];

function LandingPage() {
  const fill = useChatStore((state) => state.fill);

  return (
    <div className="landing-page" aria-labelledby="landing-title">
      <div className="landing-hero">
        <div className="landing-mark" aria-hidden="true">
          <SmithersMark part="landing-mark" />
        </div>
        <p className="landing-eyebrow">How can I help you?</p>
        <h1 id="landing-title">
          Turn ideas into <span>momentum.</span>
        </h1>
        <p className="landing-intro">
          Smithers coordinates your agents, workflows, and approvals so you can
          spend less time managing work and more time making progress.
        </p>
        <div className="landing-actions" aria-label="Get started">
          <button className="landing-primary" type="button" onClick={() => fill("")}>
            Start building <span aria-hidden="true">→</span>
          </button>
          <button
            className="landing-secondary"
            type="button"
            onClick={() => goToView("store")}
          >
            Explore workflows
          </button>
        </div>
      </div>

      <div className="landing-prompts" aria-label="Starter prompts">
        <p>Try asking Smithers to…</p>
        <div className="landing-prompt-list">
          {starterPrompts.map(({ label, prompt }) => (
            <button key={label} type="button" onClick={() => fill(prompt)}>
              <span>{label}</span>
              <span aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      </div>

      <section className="landing-features" aria-label="Smithers features">
        <article>
          <span className="landing-feature-number">01</span>
          <h2>Compose</h2>
          <p>Describe the outcome. Smithers turns intent into an executable plan.</p>
        </article>
        <article>
          <span className="landing-feature-number">02</span>
          <h2>Coordinate</h2>
          <p>Keep every agent, tool, and dependency moving in the same direction.</p>
        </article>
        <article>
          <span className="landing-feature-number">03</span>
          <h2>Stay in control</h2>
          <p>Inspect progress, approve the moments that matter, and replay safely.</p>
        </article>
      </section>
    </div>
  );
}

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
  return <LandingPage />;
}

export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
