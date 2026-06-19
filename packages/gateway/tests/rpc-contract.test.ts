import { describe, expect, test } from "bun:test";
import {
  GATEWAY_RPC_DEFINITIONS,
  GATEWAY_RPC_ERRORS,
  SMITHERS_API_VERSION,
  anyJsonSchema,
  canonicalGatewayRpcMethod,
  getGatewayRpcDefinition,
  getRequiredScopeForGatewayMethod,
  getGatewayScopeValues,
  isGatewayRpcMethod,
  listGatewayRpcMethods,
  type JsonSchema,
} from "../src/rpc/index.ts";
import { GATEWAY_SCOPE_VALUES, hasGatewayScope } from "../src/auth/scopes.ts";

/**
 * A minimal, dependency-free JSON Schema validator covering exactly the schema
 * vocabulary GATEWAY_RPC_DEFINITIONS uses: type (incl. union and "integer"),
 * properties/required, additionalProperties (false | true | sub-schema), items,
 * enum, const, nullable, minimum, and oneOf. It returns the list of validation
 * errors (empty == valid). The point is to catch a schema/example drift — most
 * importantly an additionalProperties:false object whose example carries an
 * extra (mis-named) field.
 */
function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];

  if (value === null) {
    if (schema.nullable) {
      return errors;
    }
    const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.includes("null")) {
      return errors;
    }
    if (schema.oneOf) {
      // fall through to oneOf handling below
    } else if (types.length > 0 || schema.const !== undefined || schema.enum) {
      errors.push(`${path}: null is not allowed`);
      return errors;
    } else {
      return errors;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (schema.enum && !schema.enum.includes(value as never)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub) => validateAgainstSchema(value, sub, path).length === 0);
    if (matches.length === 0) {
      errors.push(`${path}: ${JSON.stringify(value)} matched none of the oneOf branches`);
    }
    return errors;
  }

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0) {
    const actual = jsonType(value);
    const ok = types.some((t) => (t === "integer" ? actual === "integer" : actual === t || (t === "number" && actual === "integer")));
    if (!ok) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${actual}`);
      return errors;
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: ${value} is below minimum ${schema.minimum}`);
  }

  if (types.includes("object") || (schema.properties && jsonType(value) === "object")) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        errors.push(`${path}.${key}: required property missing`);
      }
    }
    for (const [key, propValue] of Object.entries(record)) {
      const propSchema = schema.properties?.[key];
      if (propSchema) {
        errors.push(...validateAgainstSchema(propValue, propSchema, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: additionalProperties:false forbids this key`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateAgainstSchema(propValue, schema.additionalProperties, `${path}.${key}`));
      }
    }
  }

  if ((types.includes("array") || jsonType(value) === "array") && schema.items && Array.isArray(value)) {
    value.forEach((item, index) => {
      errors.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${index}]`));
    });
  }

  return errors;
}

function jsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

describe("Gateway RPC contract", () => {
  test("freezes every stable v1 RPC with typed schemas and versioned errors", () => {
    expect(listGatewayRpcMethods()).toEqual([
      "launchRun",
      "resumeRun",
      "cancelRun",
      "hijackRun",
      "rewindRun",
      "submitApproval",
      "submitSignal",
      "getRun",
      "listRuns",
      "listWorkflows",
      "listApprovals",
      "streamRunEvents",
      "streamDevTools",
      "getNodeOutput",
      "getNodeDiff",
      "cronList",
      "cronCreate",
      "cronDelete",
      "cronRun",
      "listAccounts",
      "listMemoryFacts",
      "listPrompts",
      "listScores",
      "listTickets",
      "createTicket",
      "updateTicket",
      "deleteTicket",
    ]);

    for (const definition of GATEWAY_RPC_DEFINITIONS) {
      expect(definition.version).toBe(SMITHERS_API_VERSION);
      expect(definition.maturity).toBe("stable");
      expect(GATEWAY_SCOPE_VALUES).toContain(definition.requiredScope);
      expect(definition.requestSchema).toBeDefined();
      expect(definition.responseSchema).toBeDefined();
      expect(JSON.parse(JSON.stringify(definition.exampleRequest))).toEqual(definition.exampleRequest);
      expect(JSON.parse(JSON.stringify(definition.exampleResponse))).toEqual(definition.exampleResponse);
      for (const code of definition.errors) {
        expect(GATEWAY_RPC_ERRORS[code].version).toBe(SMITHERS_API_VERSION);
      }
    }
  });

  test("maps legacy methods to stable definitions without duplicating the contract", () => {
    expect(canonicalGatewayRpcMethod("runs.create")).toBe("launchRun");
    expect(canonicalGatewayRpcMethod("approvals.decide")).toBe("submitApproval");
    expect(canonicalGatewayRpcMethod("cron.trigger")).toBe("cronRun");
    expect(getGatewayRpcDefinition("runs.create")?.method).toBe("launchRun");
    expect(getRequiredScopeForGatewayMethod("health")).toBe("run:read");
    expect(getRequiredScopeForGatewayMethod("approvals.list")).toBe("run:read");
    expect(getRequiredScopeForGatewayMethod("streamDevTools")).toBe("observability:read");
    expect(getRequiredScopeForGatewayMethod("workflows.list")).toBe("run:read");
    expect(getRequiredScopeForGatewayMethod("runs.diff")).toBe("run:read");
    expect(getRequiredScopeForGatewayMethod("getDevToolsSnapshot")).toBe("observability:read");
    expect(getRequiredScopeForGatewayMethod("runs.rerun")).toBe("run:write");
    expect(getRequiredScopeForGatewayMethod("approve")).toBe("approval:submit");
    expect(isGatewayRpcMethod("launchRun")).toBe(true);
    expect(isGatewayRpcMethod("runs.create")).toBe(false);
    expect(getGatewayScopeValues()).toEqual(GATEWAY_SCOPE_VALUES);
  });

  test("enforces scoped auth with legacy compatibility", () => {
    expect(hasGatewayScope([" * "], "run:admin", "hijackRun")).toBe(true);
    expect(hasGatewayScope(["run:write"], "run:read", "getRun")).toBe(true);
    expect(hasGatewayScope(["run:read"], "run:write", "launchRun")).toBe(false);
    expect(hasGatewayScope(["read"], "observability:read", "streamDevTools")).toBe(true);
    expect(hasGatewayScope(["execute"], "run:write", "runs.create")).toBe(true);
    expect(hasGatewayScope(["approve"], "approval:submit", "submitApproval")).toBe(true);
    expect(hasGatewayScope(["admin"], "run:admin", "hijackRun")).toBe(true);
    expect(hasGatewayScope(["approval:submit"], "approval:submit", "submitApproval")).toBe(true);
    expect(hasGatewayScope(["approval:submit"], "run:read", "getRun")).toBe(false);
    expect(hasGatewayScope(["cron:write"], "cron:read", "cronList")).toBe(true);
    expect(hasGatewayScope(["cron:read"], "cron:write", "cronCreate")).toBe(false);
    expect(hasGatewayScope(["runs.*"], "run:write", "runs.create")).toBe(true);
    expect(hasGatewayScope(["getRun"], "run:read", "getRun")).toBe(true);
    expect(hasGatewayScope(["unknown"], "run:read", "getRun")).toBe(false);
  });

  test("every exampleRequest/exampleResponse validates against its own schema", () => {
    for (const definition of GATEWAY_RPC_DEFINITIONS) {
      const requestErrors = validateAgainstSchema(definition.exampleRequest, definition.requestSchema);
      expect(requestErrors, `${definition.method} exampleRequest: ${requestErrors.join("; ")}`).toEqual([]);
      const responseErrors = validateAgainstSchema(definition.exampleResponse, definition.responseSchema);
      expect(responseErrors, `${definition.method} exampleResponse: ${responseErrors.join("; ")}`).toEqual([]);
    }
  });

  test("the schema validator actually rejects additionalProperties violations", () => {
    // Guards the guard: a closed-object schema (additionalProperties:false) must
    // flag an example carrying an unexpected/misnamed field, otherwise the test
    // above would be a no-op.
    const cancelRun = getGatewayRpcDefinition("cancelRun");
    expect(cancelRun).toBeDefined();
    const driftedExample = { runId: "run_01", status: "cancelling", typo: true };
    const errors = validateAgainstSchema(driftedExample, cancelRun!.responseSchema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain("additionalProperties:false");

    // And a missing required field is caught too.
    const missingRequired = validateAgainstSchema({ status: "cancelling" }, cancelRun!.responseSchema);
    expect(missingRequired.join(" ")).toContain("required property missing");

    // And a wrong const (rewindRun's confirm must be true).
    const rewind = getGatewayRpcDefinition("rewindRun")!;
    const badConst = validateAgainstSchema({ runId: "r", frameNo: 1, confirm: false }, rewind.requestSchema);
    expect(badConst.join(" ")).toContain("expected const");
  });

  test("scope grants honor wildcard prefix grants", () => {
    // A "<prefix>.*" grant authorizes any legacy method under that prefix...
    expect(hasGatewayScope(["runs.*"], "run:write", "runs.create")).toBe(true);
    expect(hasGatewayScope(["runs.*"], "run:read", "runs.get")).toBe(true);
    expect(hasGatewayScope(["cron.*"], "cron:write", "cron.add")).toBe(true);
    // ...but does not bleed into a different prefix.
    expect(hasGatewayScope(["runs.*"], "cron:write", "cron.add")).toBe(false);
    // The full wildcard "*" authorizes everything, including admin.
    expect(hasGatewayScope(["*"], "run:admin", "hijackRun")).toBe(true);
    expect(hasGatewayScope([" * "], "cron:write", "cronCreate")).toBe(true);
  });

  test("legacy 'approve' grant implies approval:submit AND the execute family (run:write, cron:write)", () => {
    expect(hasGatewayScope(["approve"], "approval:submit", "submitApproval")).toBe(true);
    expect(hasGatewayScope(["approve"], "run:write", "launchRun")).toBe(true);
    expect(hasGatewayScope(["approve"], "run:read", "getRun")).toBe(true);
    expect(hasGatewayScope(["approve"], "cron:write", "cronCreate")).toBe(true);
    expect(hasGatewayScope(["approve"], "signal:submit", "submitSignal")).toBe(true);
    // But not the elevated admin scope.
    expect(hasGatewayScope(["approve"], "run:admin", "hijackRun")).toBe(false);
    // And the canonical "approve" method resolves to approval:submit.
    expect(getRequiredScopeForGatewayMethod("approve")).toBe("approval:submit");
  });

  test("getRequiredScopeForGatewayMethod returns undefined for an unknown method", () => {
    expect(getRequiredScopeForGatewayMethod("nonexistent")).toBeUndefined();
    expect(getRequiredScopeForGatewayMethod("runs.nope")).toBeUndefined();
    expect(getRequiredScopeForGatewayMethod("")).toBeUndefined();
  });

  test("TicketNotFound is declared and wired to the ticket mutation RPCs", () => {
    expect(GATEWAY_RPC_ERRORS.TicketNotFound).toBeDefined();
    expect(GATEWAY_RPC_ERRORS.TicketNotFound.code).toBe("TicketNotFound");
    expect(GATEWAY_RPC_ERRORS.TicketNotFound.httpStatus).toBe(404);
    expect(GATEWAY_RPC_ERRORS.TicketNotFound.version).toBe(SMITHERS_API_VERSION);
    // updateTicket and deleteTicket reference it; createTicket revives by design so it does not.
    expect(getGatewayRpcDefinition("updateTicket")!.errors).toContain("TicketNotFound");
    expect(getGatewayRpcDefinition("deleteTicket")!.errors).toContain("TicketNotFound");
    expect(getGatewayRpcDefinition("createTicket")!.errors).not.toContain("TicketNotFound");
  });

  test("ticket RPCs carry the right scopes and ticket:write implies ticket:read", () => {
    expect(getRequiredScopeForGatewayMethod("listTickets")).toBe("ticket:read");
    expect(getRequiredScopeForGatewayMethod("createTicket")).toBe("ticket:write");
    expect(getRequiredScopeForGatewayMethod("updateTicket")).toBe("ticket:write");
    expect(getRequiredScopeForGatewayMethod("deleteTicket")).toBe("ticket:write");
    // ticket:write implies ticket:read; ticket:read does NOT imply ticket:write.
    expect(hasGatewayScope(["ticket:write"], "ticket:read", "listTickets")).toBe(true);
    expect(hasGatewayScope(["ticket:read"], "ticket:write", "createTicket")).toBe(false);
    // legacy "read" reaches ticket:read; legacy "execute" reaches ticket:write.
    expect(hasGatewayScope(["read"], "ticket:read", "listTickets")).toBe(true);
    expect(hasGatewayScope(["execute"], "ticket:write", "createTicket")).toBe(true);
  });

  test("CronNotFound is declared and wired to the cron mutation RPCs", () => {
    expect(GATEWAY_RPC_ERRORS.CronNotFound).toBeDefined();
    expect(GATEWAY_RPC_ERRORS.CronNotFound.code).toBe("CronNotFound");
    expect(GATEWAY_RPC_ERRORS.CronNotFound.httpStatus).toBe(404);
    expect(GATEWAY_RPC_ERRORS.CronNotFound.version).toBe(SMITHERS_API_VERSION);
    // cronDelete and cronRun reference it as a possible error.
    expect(getGatewayRpcDefinition("cronDelete")!.errors).toContain("CronNotFound");
    expect(getGatewayRpcDefinition("cronRun")!.errors).toContain("CronNotFound");
  });

  test("anyJsonSchema oneOf branches are mutually exclusive under strict semantics", () => {
    // A strict `oneOf` validator (e.g. Ajv) requires a value to match EXACTLY one
    // branch. Integers are JSON numbers, so a separate `integer` branch would make
    // every integer match both it and `number`, failing oneOf. Assert that every
    // representative JSON value matches exactly one branch.
    expect(anyJsonSchema.oneOf).toBeDefined();
    const branches = anyJsonSchema.oneOf!;
    const samples: unknown[] = [{ a: 1 }, [1, null, "x"], "hello", 1.5, 42, true, null];
    for (const sample of samples) {
      const matchCount = branches.filter(
        (branch) => validateAgainstSchema(sample, branch).length === 0,
      ).length;
      expect(matchCount, `value ${JSON.stringify(sample)} should match exactly one oneOf branch`).toBe(1);
    }
    // Specifically: there is no standalone "integer" branch shadowing "number".
    const branchTypes = branches.map((branch) => branch.type);
    expect(branchTypes).not.toContain("integer");
    expect(branchTypes).toContain("number");
  });

  test("name/prefix grants cannot escalate beyond the dispatched method's required scope", () => {
    // A name grant authorizes its own method at that method's scope, no higher.
    expect(hasGatewayScope(["getRun"], "run:read", "getRun")).toBe(true);
    // getRun is a run:read method, so holding only "getRun" must NOT confer run:write/run:admin.
    expect(hasGatewayScope(["getRun"], "run:write", "getRun")).toBe(false);
    expect(hasGatewayScope(["getRun"], "run:admin", "getRun")).toBe(false);
    // A wildcard-prefix grant is likewise capped at the matched method's scope.
    expect(hasGatewayScope(["runs.*"], "run:read", "runs.get")).toBe(true);
    expect(hasGatewayScope(["runs.*"], "run:write", "runs.create")).toBe(true);
    // runs.get resolves to getRun (run:read), so a read-only matched method cannot grant run:admin.
    expect(hasGatewayScope(["runs.*"], "run:admin", "runs.get")).toBe(false);
    // An unknown granted method name confers nothing (no scope to resolve).
    expect(hasGatewayScope(["mysteryMethod"], "run:read", "mysteryMethod")).toBe(false);
  });

  test("granular run:admin is intentionally narrow: it does not imply observability:read or approval:submit", () => {
    // Unlike the coarse legacy "admin" super-grant, the granular run:admin scope is
    // scoped to run control (hijack/rewind) only. It deliberately does NOT bleed into
    // unrelated families — that is the entire point of granular least-privilege scopes.
    expect(hasGatewayScope(["run:admin"], "run:admin", "hijackRun")).toBe(true);
    expect(hasGatewayScope(["run:admin"], "run:read", "getRun")).toBe(true);
    expect(hasGatewayScope(["run:admin"], "observability:read", "streamDevTools")).toBe(false);
    expect(hasGatewayScope(["run:admin"], "approval:submit", "submitApproval")).toBe(false);
    expect(hasGatewayScope(["run:admin"], "signal:submit", "submitSignal")).toBe(false);
    expect(hasGatewayScope(["run:admin"], "cron:read", "cronList")).toBe(false);
    // The coarse legacy "admin" grant, by contrast, implies everything for back-compat.
    expect(hasGatewayScope(["admin"], "observability:read", "streamDevTools")).toBe(true);
    expect(hasGatewayScope(["admin"], "approval:submit", "submitApproval")).toBe(true);
  });
});
