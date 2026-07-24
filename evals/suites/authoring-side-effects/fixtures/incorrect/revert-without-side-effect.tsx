defineTool({
  name: "announce",
  execute: (args) => slack.chat.postMessage(args),
  revert: async () => {},
});
