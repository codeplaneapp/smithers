defineTool({
  name: "charge",
  execute: (args) => stripe.charges.create(args),
});
