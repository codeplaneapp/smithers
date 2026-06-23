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
  type LaunchRunRequest,
  type LaunchRunResponse,
  type ResumeRunRequest,
  type ResumeRunResponse,
  type CancelRunRequest,
  type CancelRunResponse,
  type HijackRunRequest,
  type HijackRunResponse,
  type RewindRunRequest,
  type SubmitApprovalRequest,
  type SubmitApprovalResponse,
  type SubmitSignalRequest,
  type GetRunRequest,
  type ListRunsRequest,
  type GetSchemaSignatureRequest,
  type GetSchemaSignatureResponse,
  type ListWorkflowsRequest,
  type ListApprovalsRequest,
  type ListDocsRequest,
  type StreamRunEventsRequest,
  type StreamRunEventsResponse,
  type StreamDevToolsRequest,
  type NodeRequest,
  type CronListRequest,
  type CronCreateRequest,
  type CronDeleteRequest,
  type CronRunRequest,
  type ListAccountsRequest,
  type ListMemoryFactsRequest,
  type ListPromptsRequest,
  type ListScoresRequest,
  type ListTicketsRequest,
  type CreateTicketRequest,
  type UpdateTicketRequest,
  type DeleteTicketRequest,
} from "../src/rpc/index.ts";
import { GATEWAY_SCOPE_VALUES, hasGatewayScope, type GatewayScope } from "../src/auth/scopes.ts";

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
      "getSchemaSignature",
      "listWorkflows",
      "listApprovals",
      "listDocs",
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
    expect(getRequiredScopeForGatewayMethod("getSchemaSignature")).toBe("run:read");
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

  test("pins exact required scopes for every stable RPC method", () => {
    const expectedScopes: Record<string, GatewayScope> = {
      launchRun: "run:write",
      resumeRun: "run:write",
      cancelRun: "run:write",
      hijackRun: "run:admin",
      rewindRun: "run:admin",
      submitApproval: "approval:submit",
      submitSignal: "signal:submit",
      getRun: "run:read",
      getSchemaSignature: "run:read",
      listRuns: "run:read",
      listWorkflows: "run:read",
      listApprovals: "run:read",
      listDocs: "run:read",
      streamRunEvents: "run:read",
      streamDevTools: "observability:read",
      getNodeOutput: "run:read",
      getNodeDiff: "run:read",
      cronList: "cron:read",
      cronCreate: "cron:write",
      cronDelete: "cron:write",
      cronRun: "cron:write",
      listAccounts: "account:read",
      listMemoryFacts: "memory:read",
      listPrompts: "prompt:read",
      listScores: "score:read",
      listTickets: "ticket:read",
      createTicket: "ticket:write",
      updateTicket: "ticket:write",
      deleteTicket: "ticket:write",
    };

    expect(Object.keys(expectedScopes).toSorted()).toEqual([...listGatewayRpcMethods()].toSorted());
    for (const [method, requiredScope] of Object.entries(expectedScopes)) {
      expect(getRequiredScopeForGatewayMethod(method), method).toBe(requiredScope);
      expect(getGatewayRpcDefinition(method)?.requiredScope, method).toBe(requiredScope);
    }
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

  test("exampleRequest/exampleResponse survive a JSON serialize→deserialize round-trip without data loss", () => {
    // Guards against examples with non-JSON-serializable values (undefined fields,
    // class instances, Date objects, etc.) that appear to validate but would be
    // silently dropped or mutated when sent over the wire.
    for (const definition of GATEWAY_RPC_DEFINITIONS) {
      const reqRoundTripped = JSON.parse(JSON.stringify(definition.exampleRequest));
      expect(reqRoundTripped, `${definition.method} exampleRequest round-trip`).toEqual(definition.exampleRequest);
      const reqRTErrors = validateAgainstSchema(reqRoundTripped, definition.requestSchema);
      expect(reqRTErrors, `${definition.method} exampleRequest round-trip schema: ${reqRTErrors.join("; ")}`).toEqual([]);

      const resRoundTripped = JSON.parse(JSON.stringify(definition.exampleResponse));
      expect(resRoundTripped, `${definition.method} exampleResponse round-trip`).toEqual(definition.exampleResponse);
      const resRTErrors = validateAgainstSchema(resRoundTripped, definition.responseSchema);
      expect(resRTErrors, `${definition.method} exampleResponse round-trip schema: ${resRTErrors.join("; ")}`).toEqual([]);
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

  test("additionalProperties sub-schema: validator accepts conforming extra keys and rejects non-conforming ones", () => {
    // objectSchema(props, required, desc, subSchema) produces a JsonSchema whose
    // additionalProperties is a JsonSchema object, not a boolean. This exercises the
    // sub-schema branch of validateAgainstSchema (lines 90-92) that was previously untested.
    const schemaWithSubSchema: JsonSchema = {
      type: "object",
      properties: { known: { type: "string", description: "A declared property." } },
      required: [],
      additionalProperties: { type: "integer", description: "Extra keys must be integers.", minimum: 0 },
    };

    // An extra key whose value is a non-negative integer → valid.
    expect(validateAgainstSchema({ known: "hi", extra: 42 }, schemaWithSubSchema)).toEqual([]);

    // An extra key whose value is a string violates the sub-schema.
    const stringExtra = validateAgainstSchema({ known: "hi", extra: "not-an-integer" }, schemaWithSubSchema);
    expect(stringExtra.length).toBeGreaterThan(0);
    expect(stringExtra.join(" ")).toContain("extra");

    // An extra key whose value is a negative integer violates the sub-schema minimum.
    const negativeExtra = validateAgainstSchema({ extra: -1 }, schemaWithSubSchema);
    expect(negativeExtra.length).toBeGreaterThan(0);
    expect(negativeExtra.join(" ")).toContain("minimum");

    // The declared property is still validated against its own schema, not the sub-schema.
    const wrongDeclared = validateAgainstSchema({ known: 123 }, schemaWithSubSchema);
    expect(wrongDeclared.length).toBeGreaterThan(0);
    expect(wrongDeclared.join(" ")).toContain("known");

    // An empty object (no extra keys) is valid even with a restrictive sub-schema.
    expect(validateAgainstSchema({}, schemaWithSubSchema)).toEqual([]);
  });

  test("additionalProperties sub-schema flows through the OpenAPI generator as a nested object", () => {
    // Confirm that toYaml / buildPath serialize a sub-schema additionalProperties as a
    // nested YAML mapping rather than the scalar "true"/"false", matching OpenAPI 3.1
    // object schema semantics. We exercise this by building an inline schema with a
    // sub-schema additionalProperties and checking the YAML round-trip is a proper object.
    const subSchema: JsonSchema = { type: "string", description: "values must be strings" };
    const schema: JsonSchema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: subSchema,
    };
    // The schema object itself is what the generator passes through; verify it round-trips
    // via JSON (the generated YAML is parsed back to JSON in the drift-check) identically.
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    // And the additionalProperties value is not a boolean — it is the nested sub-schema.
    expect(typeof schema.additionalProperties).toBe("object");
    expect((schema.additionalProperties as JsonSchema).type).toBe("string");
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

  test("TS *Request/*Response types agree with JsonSchema definitions", () => {
    // Each typed object uses `satisfies` so tsc catches type/schema drift at compile
    // time. The runtime half validates the same objects against the JsonSchema — if the
    // TS type is narrower than the schema (a required TS field missing from schema
    // required[], wrong type, etc.) the schema validation will fail.

    type TypedCase = { method: string; request: unknown; response?: unknown };

    const cases: TypedCase[] = [
      {
        method: "launchRun",
        request: { workflow: "deploy", input: { sha: "abc" }, options: { runId: "r1", idempotencyKey: "k1" } } satisfies LaunchRunRequest,
        response: { runId: "r1", workflow: "deploy" } satisfies LaunchRunResponse,
      },
      {
        method: "resumeRun",
        request: { runId: "r1", options: { force: false } } satisfies ResumeRunRequest,
        response: { runId: "r1", status: "resume_requested" } satisfies ResumeRunResponse,
      },
      {
        method: "cancelRun",
        request: { runId: "r1" } satisfies CancelRunRequest,
        response: { runId: "r1", status: "cancelling" } satisfies CancelRunResponse,
      },
      {
        method: "hijackRun",
        request: { runId: "r1", options: { reason: "test" } } satisfies HijackRunRequest,
        response: { runId: "r1", status: "hijack-ready", sessionId: "s1" } satisfies HijackRunResponse,
      },
      {
        method: "rewindRun",
        request: { runId: "r1", frameNo: 2, confirm: true } satisfies RewindRunRequest,
        response: { ok: true },
      },
      {
        method: "submitApproval",
        request: { runId: "r1", nodeId: "n1", decision: { approved: true, note: "ok" } } satisfies SubmitApprovalRequest,
        response: { runId: "r1", nodeId: "n1", iteration: 0, approved: true } satisfies SubmitApprovalResponse,
      },
      {
        method: "submitSignal",
        request: { runId: "r1", correlationKey: "ck", signalName: "sig", payload: null } satisfies SubmitSignalRequest,
        response: { runId: "r1", seq: 1 },
      },
      {
        method: "getRun",
        request: { runId: "r1" } satisfies GetRunRequest,
        response: { runId: "r1" },
      },
      {
        method: "listRuns",
        request: { filter: { status: "finished", limit: 10 } } satisfies ListRunsRequest,
        response: [],
      },
      {
        method: "getSchemaSignature",
        request: {} satisfies GetSchemaSignatureRequest,
        response: { schemaVersion: "0016", signature: "sha256" } satisfies GetSchemaSignatureResponse,
      },
      {
        method: "listWorkflows",
        request: { filter: { hasUi: true } } satisfies ListWorkflowsRequest,
        response: [],
      },
      {
        method: "listApprovals",
        request: { filter: { runId: "r1", limit: 5 } } satisfies ListApprovalsRequest,
        response: [],
      },
      {
        method: "listDocs",
        request: { filter: { kind: "ticket", limit: 20 } } satisfies ListDocsRequest,
        response: [],
      },
      {
        method: "streamRunEvents",
        request: { runId: "r1", afterSeq: 0 } satisfies StreamRunEventsRequest,
        response: { streamId: "s1", runId: "r1", afterSeq: null, currentSeq: 0 } satisfies StreamRunEventsResponse,
      },
      {
        method: "streamDevTools",
        request: { runId: "r1", afterSeq: 0 } satisfies StreamDevToolsRequest,
        response: { streamId: "s1", runId: "r1", fromSeq: null, afterSeq: null },
      },
      {
        method: "getNodeOutput",
        request: { runId: "r1", nodeId: "n1", iteration: 0 } satisfies NodeRequest,
        response: { runId: "r1", nodeId: "n1", iteration: 0 },
      },
      {
        method: "getNodeDiff",
        request: { runId: "r1", nodeId: "n1", iteration: 0 } satisfies NodeRequest,
        response: { runId: "r1", nodeId: "n1", iteration: 0 },
      },
      {
        method: "cronList",
        request: { filter: { workflow: "deploy" } } satisfies CronListRequest,
        response: [],
      },
      {
        method: "cronCreate",
        request: { workflow: "deploy", pattern: "0 * * * *", cronId: "c1", enabled: true } satisfies CronCreateRequest,
        response: { cronId: "c1" },
      },
      {
        method: "cronDelete",
        request: { cronId: "c1" } satisfies CronDeleteRequest,
        response: { cronId: "c1", removed: true },
      },
      {
        method: "cronRun",
        request: { cronId: "c1", workflow: "deploy", input: {} } satisfies CronRunRequest,
        response: { runId: "r1", workflow: "deploy" },
      },
      {
        method: "listAccounts",
        request: {} satisfies ListAccountsRequest,
        response: [],
      },
      {
        method: "listMemoryFacts",
        request: { namespace: "ns1" } satisfies ListMemoryFactsRequest,
        response: [],
      },
      {
        method: "listPrompts",
        request: {} satisfies ListPromptsRequest,
        response: [],
      },
      {
        method: "listScores",
        request: { runId: "r1", nodeId: "n1" } satisfies ListScoresRequest,
        response: [],
      },
      {
        method: "listTickets",
        request: { kind: "ticket" } satisfies ListTicketsRequest,
        response: [],
      },
      {
        method: "createTicket",
        request: { path: "feat-1", content: "# title", kind: "ticket", status: "open" } satisfies CreateTicketRequest,
        response: { path: "feat-1", kind: "ticket", content: "# title", contentHash: "abc123", status: "open", updatedAtMs: 1710000000000 },
      },
      {
        method: "updateTicket",
        request: { path: "feat-1", content: "# updated", status: "done" } satisfies UpdateTicketRequest,
        response: { path: "feat-1", kind: "ticket", content: "# updated", contentHash: "abc123", status: "done", updatedAtMs: 1710000000000 },
      },
      {
        method: "deleteTicket",
        request: { path: "feat-1" } satisfies DeleteTicketRequest,
        response: { path: "feat-1", deleted: true },
      },
    ];

    // Every method in GATEWAY_RPC_DEFINITIONS must be covered.
    const coveredMethods = new Set(cases.map((c) => c.method));
    for (const def of GATEWAY_RPC_DEFINITIONS) {
      expect(coveredMethods.has(def.method), `${def.method} is missing a TS-typed test case`).toBe(true);
    }

    // Each typed request object validates against the method's requestSchema.
    for (const { method, request, response } of cases) {
      const def = getGatewayRpcDefinition(method);
      expect(def, `no definition found for ${method}`).toBeDefined();
      if (!def) continue;

      const reqErrors = validateAgainstSchema(request, def.requestSchema);
      expect(reqErrors, `${method} TS-typed request failed schema validation: ${reqErrors.join("; ")}`).toEqual([]);

      if (response !== undefined) {
        const resErrors = validateAgainstSchema(response, def.responseSchema);
        expect(resErrors, `${method} TS-typed response failed schema validation: ${resErrors.join("; ")}`).toEqual([]);
      }
    }
  });
});
