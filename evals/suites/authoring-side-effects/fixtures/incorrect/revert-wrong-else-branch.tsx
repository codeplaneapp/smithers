defineTool({
  name: "announce",
  sideEffect: true,
  execute: (args) => slack.chat.postMessage(args),
  revert: async (args, ctx) => {
    const message = await findMessageByKey(ctx.idempotencyKey);
    if (message) return;
    await slack.chat.delete({ channel: args.channel, ts: ctx.output.ts });
  },
});
