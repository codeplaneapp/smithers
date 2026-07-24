defineTool({
  name: "publish",
  sideEffect: true,
  execute: () => exec("npm publish"),
});
