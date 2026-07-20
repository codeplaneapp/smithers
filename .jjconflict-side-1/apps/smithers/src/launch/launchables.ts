/** A launchable workflow and the inputs its form collects. */
export type LaunchField = {
  key: string;
  label: string;
  type: "text" | "area" | "select";
  placeholder?: string;
  options?: string[];
};

export type Launchable = {
  id: string;
  name: string;
  blurb: string;
  fields: LaunchField[];
};

export const LAUNCHABLES: Launchable[] = [
  {
    id: "research",
    name: "Deep Research",
    blurb: "fan-out + verify + synthesize",
    fields: [
      {
        key: "question",
        label: "Question",
        type: "area",
        placeholder: "What changed in the OAuth spec since 2.0?",
      },
      { key: "depth", label: "Depth", type: "select", options: ["Quick", "Standard", "Exhaustive"] },
    ],
  },
  {
    id: "implement",
    name: "Implement",
    blurb: "plan → edit → test",
    fields: [
      { key: "task", label: "Task", type: "area", placeholder: "Describe the change…" },
    ],
  },
  {
    id: "review",
    name: "Open Code Review",
    blurb: "review the current diff",
    fields: [
      { key: "target", label: "Target", type: "text", placeholder: "branch or PR #" },
    ],
  },
];

export function findLaunchable(id: string): Launchable | undefined {
  return LAUNCHABLES.find((entry) => entry.id === id);
}
