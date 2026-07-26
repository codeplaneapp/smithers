defineTool({
  name: "announce",
  sideEffect: true,
  execute: (args) => slack.chat.postMessage(args),
});
