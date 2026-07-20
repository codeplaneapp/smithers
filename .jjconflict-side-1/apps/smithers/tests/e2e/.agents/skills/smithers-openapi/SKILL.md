---
name: smithers-openapi
description: Generate AI SDK tools from OpenAPI specs. Run `smithers openapi --help` for usage details.
requires_bin: smithers
command: smithers openapi
---

# smithers openapi generate

Generate an AI SDK tools module from an OpenAPI spec.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `specPath` | `string` | yes | Path to an OpenAPI spec |
| `outputPath` | `string` | yes | Output JavaScript file for generated tools |

---

# smithers openapi list

Preview tools that would be generated from an OpenAPI spec.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `specPath` | `string` | yes | Path or URL to an OpenAPI spec |
