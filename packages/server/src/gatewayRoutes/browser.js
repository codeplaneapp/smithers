/** Validate the closed browser RPC input surface before dispatch. */
export function validateBrowserRequest(method, params) {
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw Object.assign(new Error("Invalid browser request."), { code: "InvalidRequest" });
  const value = params;
  const shapes = {
    createBrowserSession: ["source", "viewport"],
    browserAct: ["sessionId", "actionId", "expectedRevision", "action"],
    browserContext: ["sessionId", "sinceRevision", "include"],
    browserPick: ["sessionId", "point"],
    closeBrowserSession: ["sessionId"],
    listBrowserSessions: [],
  };
  const allowed = shapes[method];
  if (!allowed) throw Object.assign(new Error("Invalid browser method."), { code: "InvalidRequest" });
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw Object.assign(new Error(`Unexpected browser parameter: ${key}`), { code: "InvalidRequest" });
  const required =
    method === "createBrowserSession"
      ? ["source"]
      : method === "browserAct"
        ? ["sessionId", "actionId", "action"]
        : method === "listBrowserSessions"
          ? []
          : ["sessionId"];
  for (const key of required)
    if (!(key in value)) throw Object.assign(new Error(`${key} is required.`), { code: "InvalidRequest" });
  const fail = (message) => {
    throw Object.assign(new Error(message), { code: "InvalidRequest" });
  };
  const string = (name) => {
    if (typeof value[name] !== "string" || value[name].length < 1) fail(`${name} must be a non-empty string.`);
  };
  const exact = (candidate, name, keys, requiredKeys) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail(`${name} must be an object.`);
    for (const key of Object.keys(candidate)) if (!keys.includes(key)) fail(`${name}.${key} is not allowed.`);
    for (const key of requiredKeys) if (!(key in candidate)) fail(`${name}.${key} is required.`);
    return candidate;
  };
  const point = (candidate, name) => {
    const result = exact(candidate, name, ["x", "y"], ["x", "y"]);
    if (!["x", "y"].every((key) => typeof result[key] === "number" && Number.isFinite(result[key])))
      fail(`${name} coordinates must be finite numbers.`);
  };
  const locator = (candidate, name) => {
    const result =
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate
        : fail(`${name} must be an object.`);
    const keys = Object.keys(result);
    if (
      keys.length === 0 ||
      keys.some((key) => !["testId", "role", "name", "css"].includes(key)) ||
      ("testId" in result && keys.length !== 1) ||
      ("css" in result && keys.length !== 1) ||
      ("role" in result && !(keys.length === 1 || (keys.length === 2 && "name" in result))) ||
      ("name" in result && !("role" in result && keys.length === 2))
    )
      fail(`${name} has an invalid locator shape.`);
    for (const key of keys)
      if (typeof result[key] !== "string" || result[key].length < 1) fail(`${name}.${key} must be a non-empty string.`);
  };
  if (["browserAct", "browserContext", "browserPick", "closeBrowserSession"].includes(method)) string("sessionId");
  if (method === "browserAct") {
    string("actionId");
    if ("expectedRevision" in value && (!Number.isInteger(value.expectedRevision) || value.expectedRevision < 0))
      fail("expectedRevision must be a non-negative integer.");
    const action = exact(
      value.action,
      "action",
      [
        "kind",
        "url",
        "locator",
        "point",
        "button",
        "modifiers",
        "text",
        "replace",
        "key",
        "deltaX",
        "deltaY",
        "decision",
        "promptText",
      ],
      ["kind"],
    );
    if (
      !["navigate", "back", "forward", "reload", "stop", "click", "type", "press", "scroll", "dialog"].includes(
        action.kind,
      )
    )
      fail("action.kind is unsupported.");
    const actionFields = {
      navigate: ["kind", "url"],
      back: ["kind"],
      forward: ["kind"],
      reload: ["kind"],
      stop: ["kind"],
      click: ["kind", "locator", "point", "button", "modifiers"],
      type: ["kind", "locator", "text", "replace"],
      press: ["kind", "key", "modifiers"],
      scroll: ["kind", "deltaX", "deltaY"],
      dialog: ["kind", "decision", "promptText"],
    };
    if (Object.keys(action).some((key) => !actionFields[action.kind].includes(key)))
      fail(`action.${action.kind} contains an unsupported field.`);
    if (action.kind === "navigate" && (typeof action.url !== "string" || action.url.length < 1))
      fail("action.url must be a non-empty string.");
    if (action.kind === "click") {
      const hasLocator = "locator" in action;
      const hasPoint = "point" in action;
      if (hasLocator === hasPoint) fail("click requires exactly one of locator or point.");
      if (hasLocator) locator(action.locator, "action.locator");
      else point(action.point, "action.point");
    }
    if (action.kind === "type") {
      locator(action.locator, "action.locator");
      if (typeof action.text !== "string" || action.text.length < 1) fail("action.text must be a non-empty string.");
      if ("replace" in action && typeof action.replace !== "boolean") fail("action.replace must be a boolean.");
    }
    if (action.kind === "press" && (typeof action.key !== "string" || action.key.length < 1))
      fail("action.key must be a non-empty string.");
    if (action.kind === "scroll")
      for (const key of ["deltaX", "deltaY"])
        if (typeof action[key] !== "number" || !Number.isFinite(action[key]))
          fail(`action.${key} must be a finite number.`);
    if (action.kind === "dialog" && !["accept", "dismiss"].includes(action.decision))
      fail("action.decision is invalid.");
    if (
      action.kind === "dialog" &&
      "promptText" in action &&
      (typeof action.promptText !== "string" || action.promptText.length < 1)
    )
      fail("action.promptText must be a non-empty string.");
    if ("button" in action && !["left", "right", "middle"].includes(action.button)) fail("action.button is invalid.");
    if (
      "modifiers" in action &&
      (!Array.isArray(action.modifiers) ||
        action.modifiers.some((modifier) => typeof modifier !== "string" || modifier.length < 1))
    )
      fail("action.modifiers must contain non-empty strings.");
  }
  if (method === "createBrowserSession") {
    const source = exact(value.source, "source", ["kind", "url", "port", "path"], ["kind"]);
    if (source.kind === "url") {
      if (
        Object.keys(source).some((key) => !["kind", "url"].includes(key)) ||
        typeof source.url !== "string" ||
        source.url.length < 1
      )
        fail("source.url must be a non-empty string.");
    } else if (source.kind === "dev-server") {
      if (Object.keys(source).some((key) => !["kind", "port", "path"].includes(key)))
        fail("source contains an unsupported field.");
      if (!Number.isInteger(source.port) || source.port < 1 || source.port > 65535) fail("source.port is invalid.");
      if ("path" in source && (typeof source.path !== "string" || source.path.length < 1))
        fail("source.path must be a non-empty string.");
    } else fail("source.kind is invalid.");
    if ("viewport" in value) {
      const viewport = exact(value.viewport, "viewport", ["width", "height"], ["width", "height"]);
      for (const key of ["width", "height"])
        if (!Number.isInteger(viewport[key]) || viewport[key] < 1 || viewport[key] > (key === "width" ? 3840 : 2160))
          fail(`viewport.${key} is invalid.`);
    }
  }
  if (method === "browserContext") {
    if ("sinceRevision" in value && (!Number.isInteger(value.sinceRevision) || value.sinceRevision < 0))
      fail("sinceRevision must be a non-negative integer.");
    if (
      "include" in value &&
      (!Array.isArray(value.include) ||
        value.include.some(
          (item) =>
            ![
              "visible-text",
              "accessibility",
              "interactive-elements",
              "screenshot",
              "selections",
              "recent-actions",
              "console-summary",
              "network-summary",
            ].includes(item),
        ))
    )
      fail("include contains an unsupported context slice.");
  }
  if (method === "browserPick") point(value.point, "point");
  return value;
}
