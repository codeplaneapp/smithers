defineTool({
  name: "slack",
  sideEffect: true,
  idempotent: false,
  execute: (args, ctx) => {
    console.info(ctx.idempotencyKey);
    return slack.chat.postMessage(args);
  },
});
