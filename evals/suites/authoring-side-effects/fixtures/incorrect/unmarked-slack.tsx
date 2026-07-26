defineTool({
  name: "slack",
  execute: (args) => slack.chat.postMessage(args),
});
