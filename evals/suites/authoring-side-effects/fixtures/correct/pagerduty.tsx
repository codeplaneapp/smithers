defineTool({
  name: "incident",
  sideEffect: true,
  execute: (args) => pagerduty.triggerIncident(args),
});
