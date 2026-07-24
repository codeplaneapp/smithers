defineTool({
  name: "charge",
  sideEffect: true,
  execute: (args) => stripe.charges.create(args),
  revert: async (_args, ctx) => {
    const charge = await findChargeByKey(ctx.idempotencyKey);
    if (charge) await stripe.refunds.create({ charge: charge.id });
  },
});
