defineTool({
  name: "view",
  sideEffect: true,
  execute: () => exec("gh pr view 42"),
});
