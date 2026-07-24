defineTool({
  name: "insert",
  sideEffect: true,
  execute: (row) => db.insert(row),
});
