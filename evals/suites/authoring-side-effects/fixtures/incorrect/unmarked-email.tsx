defineTool({
  name: "email",
  execute: (args) => transport.sendMail(args),
});
