defineTool({
  name: "announce",
  sideEffect: true,
  execute: (args) => slack.chat.postMessage(args),
  revert: async (_args, ctx) => {
    const message = await findMessageByKey(ctx.idempotencyKey);
    if (message) await s3.deleteObject({ Bucket: "other", Key: message.ts });
  },
});
