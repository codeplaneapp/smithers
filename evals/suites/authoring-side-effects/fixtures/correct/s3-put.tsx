defineTool({
  name: "upload",
  sideEffect: true,
  execute: (input) => s3.putObject(input),
});
