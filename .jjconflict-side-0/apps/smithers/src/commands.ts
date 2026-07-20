/**
 * The three top-level views, as the command pill presents them. Pure data with
 * no component or store imports, so workflows and notifications can reference a
 * view id without pulling in the router graph.
 */
export type CommandId = "chat" | "store";

export type Command = {
  id: CommandId;
  label: string;
  color: string;
  hint: string;
};

export const COMMANDS: Command[] = [
  {
    id: "store",
    label: "Store",
    color: "#bf5b16",
    hint: "Browse the workflow app store",
  },
];
