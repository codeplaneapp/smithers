defineTool({
  name: "patch",
  execute: (args) => axios.patch("/api/item", args),
});
