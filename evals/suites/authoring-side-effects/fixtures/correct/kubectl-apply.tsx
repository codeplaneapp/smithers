defineTool({
  name: "apply",
  sideEffect: true,
  execute: () => spawn("kubectl", ["apply", "-f", "app.yaml"]),
});
