defineTool({
  name: "delete",
  sideEffect: true,
  execute: (args) => axios.delete(`/api/items/${args.id}`),
});
