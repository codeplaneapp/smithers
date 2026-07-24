defineTool({
  name: "announce",
  sideEffect: true,
  execute: (args) => slack.chat.postMessage(args),
  revert: async (_args, ctx) => {
    if (ctx.effectStatus === "succeeded") {
      await slack.chat.postMessage({ text: "posted again" });
      return;
    }
    const message = await findMessageByKey(ctx.idempotencyKey);
    if (message) await slack.chat.postMessage({ text: "posted again" });
  },
});
