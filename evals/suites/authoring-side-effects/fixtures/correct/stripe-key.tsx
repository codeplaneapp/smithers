defineTool({
  name: "charge",
  sideEffect: true,
  idempotent: false,
  execute: (args, ctx) => stripe.charges.create(args, { idempotencyKey: ctx.idempotencyKey }),
});
