/** Validate the closed browser RPC input surface before dispatch. */
export function validateBrowserRequest(method, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw Object.assign(new Error("Invalid browser request."), { code: "InvalidRequest" });
  const value = params;
  const required = method === "createBrowserSession" ? ["source"] : method === "browserAct" ? ["sessionId", "actionId", "action"] : ["sessionId"];
  for (const key of required) if (!(key in value)) throw Object.assign(new Error(`${key} is required.`), { code: "InvalidRequest" });
  if (["browserAct", "browserContext", "browserPick", "closeBrowserSession"].includes(method) && typeof value.sessionId !== "string") throw Object.assign(new Error("sessionId must be a string."), { code: "InvalidRequest" });
  if (method === "browserAct" && typeof value.actionId !== "string") throw Object.assign(new Error("actionId must be a string."), { code: "InvalidRequest" });
  return value;
}
