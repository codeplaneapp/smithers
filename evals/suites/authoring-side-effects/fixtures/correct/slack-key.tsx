defineTool({
  name: "slack",
  sideEffect: true,
  idempotent: false,
  execute: (args, ctx) => slack.chat.postMessage({ ...args, key: ctx.idempotencyKey }),
});
