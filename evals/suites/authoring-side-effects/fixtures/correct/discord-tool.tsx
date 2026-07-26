defineTool({
  name: "discord",
  sideEffect: true,
  execute: (args) => discord.createMessage(args.channel, args.text),
});
