defineTool({
  name: "post",
  sideEffect: true,
  execute: (args) => fetch("/api/report", { method: "POST", body: JSON.stringify(args) }),
});
