defineTool({
  name: "merge",
  sideEffect: true,
  execute: () => exec("gh pr merge 42"),
});
