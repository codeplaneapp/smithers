import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Errors from "../src/RegistryError.ts"

describe("FlowDescriptor", () => {
  it("round-trips every descriptor field", () => {
    const descriptor = new Descriptor.FlowDescriptor({
      name: "review/read-pr",
      description: "Review a pull request",
      body: new Descriptor.BodyRefMarkdown({
        path: "/project/flows/review/read-pr/flow.mdx",
        baseDirectory: "/project/flows/review/read-pr"
      }),
      input: new Descriptor.SchemaRefMarkdownArgs({}),
      output: new Descriptor.SchemaRefModule({ path: "/project/flows/review/read-pr/flow.ts", field: "output" }),
      model: Option.some("smart"),
      flows: ["read-pr"],
      capabilities: ["git:read", "net:get"],
      effects: {
        reads: ["src/**"],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.some("sandbox"),
      modelInvocable: true,
      path: "/project/flows/review/read-pr/flow.mdx",
      frontmatter: { description: "Review a pull request", retained: { raw: true } },
      provenance: new Descriptor.Provenance({ source: "project", root: "/project/flows" })
    })

    const encoded = Schema.encodeSync(Descriptor.FlowDescriptor)(descriptor)
    const decoded = Schema.decodeUnknownSync(Descriptor.FlowDescriptor)(encoded)

    expect(encoded).toMatchObject({
      name: "review/read-pr",
      description: "Review a pull request",
      body: {
        _tag: "Markdown",
        path: "/project/flows/review/read-pr/flow.mdx",
        baseDirectory: "/project/flows/review/read-pr"
      },
      input: { _tag: "MarkdownArgs" },
      output: { _tag: "Module", path: "/project/flows/review/read-pr/flow.ts", field: "output" },
      capabilities: ["git:read", "net:get"],
      model: { _tag: "Some", value: "smart" },
      flows: ["read-pr"],
      effects: {
        reads: ["src/**"],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      modelInvocable: true,
      path: "/project/flows/review/read-pr/flow.mdx",
      frontmatter: { description: "Review a pull request", retained: { raw: true } },
      provenance: { source: "project", root: "/project/flows" }
    })
    expect(Option.getOrThrow(decoded.placement)).toBe("sandbox")
    expect(decoded).toEqual(descriptor)
    expect(() => JSON.stringify(encoded)).not.toThrow()
  })

  it("retains tagged body and schema reference variants", () => {
    expect(Schema.decodeUnknownSync(Descriptor.BodyRef)({ _tag: "Module", path: "/project/flow.ts" })).toEqual(
      new Descriptor.BodyRefModule({ path: "/project/flow.ts" })
    )
    expect(
      Schema.decodeUnknownSync(Descriptor.FlowBody)({
        _tag: "Prompt",
        text: "Use the available tools.",
        baseDirectory: "/project/flows/review"
      })
    ).toEqual(
      new Descriptor.FlowBodyPrompt({
        text: "Use the available tools.",
        baseDirectory: "/project/flows/review"
      })
    )
    expect(Schema.decodeUnknownSync(Descriptor.SchemaRef)({ _tag: "MarkdownOutput" })).toEqual(
      new Descriptor.SchemaRefMarkdownOutput({})
    )
    expect(Schema.decodeUnknownSync(Descriptor.SchemaRef)({ _tag: "None" })).toEqual(new Descriptor.SchemaRefNone({}))
  })

  it("round-trips an inline input schema", () => {
    const document = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        command: { type: "string" },
        reads: { type: "array", items: { type: "string" } }
      },
      required: ["command"],
      additionalProperties: false
    }
    const input = new Descriptor.SchemaRefInline({ document })
    const encodedInput = Schema.encodeSync(Descriptor.SchemaRef)(input)

    expect(input.document).toEqual(document)
    expect(encodedInput).toEqual({ _tag: "Inline", document })
    expect(Schema.decodeUnknownSync(Descriptor.SchemaRef)(encodedInput)).toEqual(input)

    const descriptor = new Descriptor.FlowDescriptor({
      name: "shell",
      description: "Runs a shell command",
      body: new Descriptor.BodyRefModule({ path: "/project/flows/shell/flow.ts" }),
      input,
      output: new Descriptor.SchemaRefNone({}),
      model: Option.none(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      },
      placement: Option.none(),
      modelInvocable: true,
      path: "/project/flows/shell/flow.ts",
      frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "project", root: "/project/flows" })
    })
    const encodedDescriptor = Schema.encodeSync(Descriptor.FlowDescriptor)(descriptor)

    expect(Schema.decodeUnknownSync(Descriptor.FlowDescriptor)(encodedDescriptor)).toEqual(descriptor)
  })

  it("round-trips a declared budget and answers an absent one as unbounded", () => {
    const base = {
      name: "review",
      description: "Review a pull request",
      body: new Descriptor.BodyRefMarkdown({
        path: "/project/flows/review/SKILL.md",
        baseDirectory: "/project/flows/review"
      }),
      input: new Descriptor.SchemaRefMarkdownArgs({}),
      output: new Descriptor.SchemaRefMarkdownOutput({}),
      model: Option.none<string>(),
      flows: [],
      capabilities: [],
      effects: {
        reads: [],
        writes: [],
        mode: "hermetic" as const,
        onConflict: "serialize" as const,
        tier: "sealed" as const
      },
      placement: Option.none<Descriptor.Placement>(),
      modelInvocable: true,
      path: "/project/flows/review/SKILL.md",
      frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "project", root: "/project/flows" })
    }
    const declared = new Descriptor.FlowDescriptor({ ...base, budget: { tokens: 120000, milliseconds: 900000 } })
    const undeclared = new Descriptor.FlowDescriptor(base)

    // A descriptor crosses into a control-plane envelope as JSON, so the two
    // ceilings have to survive the encode a plan is stored under.
    const encoded = Schema.encodeSync(Descriptor.FlowDescriptor)(declared)
    expect(encoded).toMatchObject({ budget: { tokens: 120000, milliseconds: 900000 } })
    expect(Schema.decodeUnknownSync(Descriptor.FlowDescriptor)(encoded)).toEqual(declared)
    expect(Descriptor.budgetOf(declared)).toEqual({ tokens: 120000, milliseconds: 900000 })

    // Absent is unbounded, and it is the named value rather than a fresh empty
    // object, so a host cannot mistake one host's silence for another's.
    expect(undeclared.budget).toBeUndefined()
    expect(Descriptor.budgetOf(undeclared)).toBe(Descriptor.budgetUnbounded)
    expect(Descriptor.budgetUnbounded).toEqual({})
  })

  it.each([
    ["MarkdownArgs", new Descriptor.SchemaRefMarkdownArgs({}), Descriptor.SchemaRefMarkdownArgs],
    ["MarkdownOutput", new Descriptor.SchemaRefMarkdownOutput({}), Descriptor.SchemaRefMarkdownOutput],
    [
      "Module",
      new Descriptor.SchemaRefModule({ path: "/project/flows/review/flow.ts", field: "input" }),
      Descriptor.SchemaRefModule
    ],
    ["None", new Descriptor.SchemaRefNone({}), Descriptor.SchemaRefNone],
    ["Inline", new Descriptor.SchemaRefInline({ document: { type: "string" } }), Descriptor.SchemaRefInline]
  ])("decodes the %s schema reference from its encoded form", (_tag, reference, Variant) => {
    const encoded = Schema.encodeSync(Descriptor.SchemaRef)(reference)
    const decoded = Schema.decodeUnknownSync(Descriptor.SchemaRef)(encoded)

    expect(decoded).toBeInstanceOf(Variant)
    expect(decoded).toEqual(reference)
  })

  it("keeps warning codes stable", () => {
    const warning = Schema.decodeUnknownSync(Descriptor.DiscoveryWarning)({
      code: "unsupported_input_schema",
      path: "/project/flows/review/flow.mdx",
      message: "Markdown flows use the fixed args schema"
    })

    expect(warning.code).toBe("unsupported_input_schema")
    expect(
      Schema.decodeUnknownOption(Descriptor.DiscoveryWarning)({
        code: "unsupported-schema",
        path: "/project/flows/review/flow.mdx",
        message: "invalid"
      })
    ).toEqual(Option.none())
  })
})

describe("registry errors", () => {
  it("formats discovery and registry operation data", () => {
    const cause = new Error("permission denied")
    expect(
      Errors.discoveryError({ code: "read_failed", method: "scan", description: "permission denied", cause })
    ).toMatchObject({
      _tag: "flows/registry/DiscoveryError",
      code: "read_failed",
      module: "Discovery",
      method: "scan",
      message: "read_failed: Discovery.scan: permission denied",
      cause
    })
    expect(Errors.registryError({ code: "not_found", module: "Lookup", method: "get" })).toMatchObject({
      _tag: "flows/registry/RegistryError",
      code: "not_found",
      module: "Lookup",
      method: "get",
      message: "not_found: Lookup.get"
    })
  })
})
