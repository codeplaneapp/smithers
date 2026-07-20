# image-generation/

`createImageGenerationTool.js` — a provider-injected `generate_image` tool,
plus type sidecars (`ImageGenerationProvider.ts`, `ImageGenerationRequest.ts`,
`ImageGenerationResult.ts`, `ImageGenerationToolOptions.ts`).

The provider boundary (`ImageGenerationProvider.generateImage`) keeps Smithers
vendor-neutral; `options.asToolset` returns `{ [name]: tool }` for direct
mounting into an agent's toolset.

Input is validated and normalized at call time: `prompt` is required and
`count` is clamped into the advertised [1, 10] range — the JSON schema alone
does not enforce it.

Has a dedicated package export:
`./image-generation/createImageGenerationTool`.
