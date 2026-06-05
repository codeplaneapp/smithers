import type { CommandId } from "../CommandMenu";

export type StoreWorkflow = {
  id: string;
  name: string;
  description: string;
  /** Emoji shown in the card badge. */
  icon: string;
  category: string;
  /** Accent color for the card. */
  color: string;
  /** If set, opening the workflow switches to this view. */
  command?: CommandId;
  /** If set, opening prefills the chat composer with this starter prompt. */
  starter?: string;
};

/** The browsable catalog shown in the workflow store. */
export const STORE_WORKFLOWS: StoreWorkflow[] = [
  {
    id: "askme",
    name: "Ask Me",
    description:
      "Smithers interviews you one question at a time to turn a rough idea into a clear spec.",
    icon: "🎤",
    category: "Planning",
    color: "#6d56d8",
    command: "askme",
  },
  {
    id: "brainstorm",
    name: "Brainstorm",
    description: "Spin up a pile of ideas and fresh angles on any topic.",
    icon: "💡",
    category: "Ideation",
    color: "#f5a623",
    starter: "Brainstorm ideas for: ",
  },
  {
    id: "summarize",
    name: "Summarize",
    description: "Paste anything long and get a tight, clear summary.",
    icon: "📝",
    category: "Writing",
    color: "#356fd2",
    starter: "Summarize this clearly:\n\n",
  },
  {
    id: "explain",
    name: "Explain Simply",
    description: "Get any concept explained in plain, everyday language.",
    icon: "🧒",
    category: "Learning",
    color: "#0f8f78",
    starter: "Explain this like I'm ten: ",
  },
  {
    id: "review",
    name: "Code Review",
    description: "Paste a diff or snippet for a quick review of bugs and fixes.",
    icon: "🔍",
    category: "Engineering",
    color: "#2670a9",
    starter: "Review this code and flag bugs and improvements:\n\n",
  },
  {
    id: "plan",
    name: "Plan a Feature",
    description: "Turn a feature idea into an ordered, step-by-step plan.",
    icon: "🗺️",
    category: "Planning",
    color: "#bf5b16",
    starter: "Break this feature into a step-by-step plan: ",
  },
  {
    id: "decide",
    name: "Pros & Cons",
    description: "Weigh a decision and get a clear recommendation.",
    icon: "⚖️",
    category: "Decisions",
    color: "#a34d9f",
    starter: "Give the pros, cons, and your recommendation for: ",
  },
  {
    id: "name",
    name: "Name It",
    description: "Get naming ideas for a project, product, or feature.",
    icon: "🏷️",
    category: "Creative",
    color: "#d6336c",
    starter: "Suggest 10 names for: ",
  },
];
