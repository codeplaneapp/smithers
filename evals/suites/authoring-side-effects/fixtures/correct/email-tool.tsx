defineTool({
  name: "email",
  sideEffect: true,
  execute: (args) => transport.sendMail(args),
});
