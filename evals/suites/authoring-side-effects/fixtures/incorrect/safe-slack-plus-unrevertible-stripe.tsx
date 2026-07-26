defineTool({
  name: "safe-slack",
  sideEffect: true,
  execute: (args) => slack.chat.postMessage(args),
  revert: async (_args, ctx) => {
    const message = await findMessageByKey(ctx.idempotencyKey);
    if (message) await slack.chat.delete({ ts: message.ts });
  },
});

defineTool({
  name: "unrevertible-stripe",
  sideEffect: true,
  execute: (args) => stripe.charges.create(args),
});
