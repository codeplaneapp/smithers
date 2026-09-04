export const backend = "sqlite";

export const repoCommands = {
  test: "bun test tests",
} as const;

export default { backend, repoCommands };
