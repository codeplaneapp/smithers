defineTool({
  name: "announce",
  sideEffect: true,
  execute: (args) => slack.chat.postMessage(args),
  revert: async (args, ctx) => {
    if (ctx.effectStatus === "succeeded") {
      await slack.chat.delete({ channel: args.channel, ts: ctx.output.ts });
    }
  },
});
