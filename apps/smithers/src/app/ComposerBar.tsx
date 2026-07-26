import type { FormEvent } from "react";
import { useChatStore } from "../chat/chatStore";
import { CommandMenu } from "../CommandMenu";
import { MoonIcon } from "../icons/MoonIcon";
import { SunIcon } from "../icons/SunIcon";
import { PanelLeftIcon } from "../icons/PanelLeftIcon";
import { withAgentSystem } from "../control/agentSystemPrompt";
import { composeThenLaunchRun, runSlash } from "./runSlash";
import { goToView } from "./navigation";
import { usePreferencesStore } from "./preferencesStore";
import { useRouteStore } from "./routeStore";

/**
 * The composer. You talk to the concierge here: it answers in the transcript and
 * aggressively backgrounds Smithers workflows. Natural language ("ship …") and
 * slash commands (/run, /logs, /sidebar, …) route locally before falling through
 * to the concierge chat. The cloud app's GitHub/sandbox toolbar is dropped.
 */
export function ComposerBar() {
  const query = useChatStore((state) => state.query);
  const setQuery = useChatStore((state) => state.setQuery);
  const registerInput = useChatStore((state) => state.registerInput);
  const theme = usePreferencesStore((state) => state.theme);
  const layout = usePreferencesStore((state) => state.layout);
  const toggleTheme = usePreferencesStore((state) => state.toggleTheme);
  const toggleLayout = usePreferencesStore((state) => state.toggleLayout);
  const surface = useRouteStore((state) => state.surface);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const chat = useChatStore.getState();
    const raw = chat.query.trim();
    if (!raw || chat.pending || chat.streaming) return;

    // Plain language to open the store.
    if (/^(open |show |go to )?(the )?store$/i.test(raw)) {
      chat.setQuery("");
      goToView("store");
      return;
    }

    // Layout slash: flip the Arc-style layout.
    const layoutSlash = raw.match(/^\/(sidebar|rail|dock|full|normal)$/i);
    if (layoutSlash) {
      const keyword = layoutSlash[1].toLowerCase();
      usePreferencesStore.getState().setLayout(keyword === "sidebar" || keyword === "rail" ? "sidebar" : "normal");
      chat.setQuery("");
      return;
    }

    // Feature slash commands (/run, /logs, /agents, …) open a surface or launch.
    const featureSlash = raw.match(/^\/(\w+)\b\s*([\s\S]*)$/);
    if (featureSlash && runSlash(featureSlash[1].toLowerCase(), featureSlash[2].trim())) {
      chat.setQuery("");
      return;
    }

    // Natural-language launch: "ship …" backgrounds an implement run.
    const shipPhrase = raw.match(/^ship\s+(.+)$/i);
    if (shipPhrase) {
      chat.setQuery("");
      void composeThenLaunchRun("implement", `Implement · ${shipPhrase[1].trim()}`);
      return;
    }

    // Default: talk to the concierge. withAgentSystem appends the app-control
    // protocol so the agent can drive the UI (gated by the approval ring).
    chat.setQuery("");
    void chat.send(raw, withAgentSystem(undefined));
  };

  return (
    <form className="composer-card" onSubmit={handleSubmit}>
      <div className="composer-top-row">
        <div className="composer-input">
          <input
            aria-label="Message Smithers"
            autoComplete="off"
            placeholder="Ask Smithers to build…"
            ref={registerInput}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <nav className="top-controls" aria-label="View navigation">
          {surface === null ? (
            <button
              aria-label={layout === "sidebar" ? "Exit sidebar layout" : "Switch to sidebar layout"}
              aria-pressed={layout === "sidebar"}
              className="nav-button"
              type="button"
              onClick={toggleLayout}
            >
              <PanelLeftIcon />
            </button>
          ) : null}
          <button
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="nav-button"
            type="button"
            onClick={toggleTheme}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <CommandMenu />
        </nav>
      </div>
    </form>
  );
}
