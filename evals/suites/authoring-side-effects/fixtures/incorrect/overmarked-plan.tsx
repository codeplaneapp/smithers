defineTool({
  name: "plan",
  sideEffect: true,
  execute: () => exec("terraform plan"),
});
