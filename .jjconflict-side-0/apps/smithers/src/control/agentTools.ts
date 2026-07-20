import { useChatStore } from "../chat/chatStore";
import { goToView, setProject } from "../app/navigation";
import { usePreferencesStore } from "../app/preferencesStore";
import { useUiStore } from "../app/uiStore";
import { startWorkflowRun } from "../gateway/startWorkflowRun";

/**
 * A directive the agent emits to drive the app. It arrives as one JSON object on
 * a line inside a ```` ```smithers:action ```` block in the model's reply (see
 * parseAgentDirectives). `reason` is only carried by the requestControl directive.
 */
export type AgentDirective = {
  tool: string;
  args?: Record<string, unknown>;
  reason?: string;
};

/**
 * One app action, exposed two ways: `run` dispatches it against the existing
 * domain stores (the same code paths a user's click takes), and the name +
 * description + argHint render the tool catalog the model sees. `describe` turns
 * a concrete call into the human-readable line the approval dialog lists.
 */
type AppAction = {
  name: string;
  description: string;
  /** Argument shape shown to the model, e.g. `theme: "light" | "dark"`. */
  argHint: string;
  describe: (args?: Record<string, unknown>) => string;
  run: (args?: Record<string, unknown>) => void;
};

function str(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}

function viewLabel(view: string | undefined): string {
  switch (view) {
    case "askme":
      return "Ask Me";
    case "store":
      return "Store";
    case "home":
      return "Home";
    default:
      return view ?? "the app";
  }
}

function ellipsis(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The action registry: the single source for both the agent's tool catalog and
 * the dispatcher. Every entry wraps an action that already exists on a domain
 * store or navigation, so the agent can only ever do what the user can.
 */
export const APP_ACTIONS: AppAction[] = [
  {
    name: "navigate",
    description: "Switch the main view.",
    argHint: 'view: "home" | "store"',
    describe: (args) => `Go to the ${viewLabel(str(args, "view"))} view`,
    run: (args) => {
      const view = str(args, "view");
      if (view === "home" || view === "store") {
        goToView(view);
      }
    },
  },
  {
    name: "setTheme",
    description: "Set light or dark mode.",
    argHint: 'theme: "light" | "dark"',
    describe: (args) => `Switch to ${str(args, "theme") ?? "a"} theme`,
    run: (args) => {
      const theme = str(args, "theme");
      if (
        (theme === "light" || theme === "dark") &&
        usePreferencesStore.getState().theme !== theme
      ) {
        usePreferencesStore.getState().toggleTheme();
      }
    },
  },
  {
    name: "toggleTheme",
    description: "Toggle between light and dark mode.",
    argHint: "",
    describe: () => "Toggle light/dark mode",
    run: () => usePreferencesStore.getState().toggleTheme(),
  },
  {
    name: "setLayout",
    description: "Choose the normal bottom-dock layout or the sidebar rail.",
    argHint: 'layout: "normal" | "sidebar"',
    describe: (args) => `Switch to the ${str(args, "layout") ?? "?"} layout`,
    run: (args) => {
      const layout = str(args, "layout");
      if (layout === "normal" || layout === "sidebar") {
        usePreferencesStore.getState().setLayout(layout);
      }
    },
  },
  {
    name: "toggleLayout",
    description: "Toggle the sidebar layout on or off.",
    argHint: "",
    describe: () => "Toggle the sidebar layout",
    run: () => usePreferencesStore.getState().toggleLayout(),
  },
  {
    name: "setProject",
    description: "Select the active project.",
    argHint: "project: string",
    describe: (args) => `Switch the project to ${str(args, "project") ?? "?"}`,
    run: (args) => {
      const project = str(args, "project");
      if (project && project.trim()) {
        setProject(project.trim());
      }
    },
  },
  {
    name: "fillComposer",
    description: "Type text into the message composer (does not send it).",
    argHint: "text: string",
    describe: (args) => `Type “${ellipsis(str(args, "text") ?? "", 40)}” into the composer`,
    run: (args) => {
      const text = str(args, "text");
      if (typeof text === "string") {
        useChatStore.getState().fill(text);
      }
    },
  },
  {
    name: "toggleDictation",
    description: "Start or stop voice dictation.",
    argHint: "",
    describe: () => "Toggle voice dictation",
    run: () => useUiStore.getState().toggleDictation(),
  },
  {
    name: "launchRun",
    description: "Launch a new run and post its live card to the chat.",
    argHint: "title?: string",
    describe: (args) => {
      const title = str(args, "title");
      return title ? `Launch a run: ${title}` : "Launch a run";
    },
    run: (args) => {
      const title = str(args, "title");
      void startWorkflowRun({
        workflowKey: "implement",
        inputs: title && title.trim() ? { prompt: title.trim() } : {},
      });
    },
  },
  {
    name: "startWorkflow",
    description: "Delegate real work to a registered Smithers workflow and post its live run card.",
    argHint: "workflowKey: string, inputs?: object",
    describe: (args) => `Start workflow ${str(args, "workflowKey") ?? "?"}`,
    run: (args) => {
      const workflowKey = str(args, "workflowKey");
      const inputs = args?.inputs;
      if (!workflowKey || !workflowKey.trim()) return;
      void startWorkflowRun({
        workflowKey: workflowKey.trim(),
        inputs:
          typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)
            ? inputs as Record<string, unknown>
            : {},
      });
    },
  },
];

const REGISTRY = new Map(APP_ACTIONS.map((action) => [action.name, action]));

/** Run a validated directive against the stores. Unknown tools are ignored. */
export function dispatchDirective(directive: AgentDirective): void {
  REGISTRY.get(directive.tool)?.run(directive.args);
}

/** One human-readable line for the approval dialog. */
export function describeDirective(directive: AgentDirective): string {
  const entry = REGISTRY.get(directive.tool);
  if (entry) {
    return entry.describe(directive.args);
  }
  if (directive.tool === "releaseControl") {
    return "Hand control back to you";
  }
  if (directive.tool === "requestControl") {
    return directive.reason ?? "Take control of the app";
  }
  return `${directive.tool}(${JSON.stringify(directive.args ?? {})})`;
}
