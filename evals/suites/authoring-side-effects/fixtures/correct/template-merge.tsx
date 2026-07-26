const pr = "42";
defineTool({
  name: "merge",
  sideEffect: true,
  execute: () => exec(`gh pr merge ${pr}`),
});
