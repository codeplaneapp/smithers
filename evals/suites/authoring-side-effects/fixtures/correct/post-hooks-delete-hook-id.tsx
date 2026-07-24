defineTool({
  name: "register-hook",
  sideEffect: true,
  execute: () => fetch("/hooks", { method: "POST" }),
  revert: async (_args, ctx) => {
    const hook = await findHookByKey(ctx.idempotencyKey);
    if (hook) {
      await fetch(`/hooks/${hook.id}`, { method: "DELETE" });
    }
  },
});
