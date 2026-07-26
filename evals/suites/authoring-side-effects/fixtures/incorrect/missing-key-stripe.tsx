defineTool({
  name: "charge",
  sideEffect: true,
  idempotent: false,
  execute: (args, ctx) => {
    audit(ctx.idempotencyKey);
    return stripe.charges.create(args);
  },
});
