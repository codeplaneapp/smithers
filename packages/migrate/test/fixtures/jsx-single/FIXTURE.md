# Fixture: `jsx-single`

A single-file Smithers 0.x JSX workflow with MDX prompts, a bun test, and no database.

Origin: `/Users/williamcory/smithers` at commit `cfb570f193` (Smithers 0.35.0).

| Fixture path | Origin path |
| --- | --- |
| `simple-workflow.jsx` | `examples/simple-workflow.jsx` |
| `_example-kit.js` | `examples/_example-kit.js` |
| `prompts/simple-workflow/research.mdx` | `examples/prompts/simple-workflow/research.mdx` |
| `prompts/simple-workflow/write.mdx` | `examples/prompts/simple-workflow/write.mdx` |
| `tests/simple-workflow.test.ts` | `examples/tests/simple-workflow.test.ts` |
| `tests/_setup.ts` | `examples/tests/_setup.ts` |
| `bunfig.toml` | `examples/bunfig.toml` |
| `preload.js` | `preload.js` (repository root) |
| `mdx-assets.d.ts` | `examples/mdx-assets.d.ts` |

Sanitizations, and nothing else:

- `tests/_setup.ts`: `await import("../../packages/smithers/node_modules/ai")` becomes `await import("ai")`, because the fixture is not inside the old monorepo.
- `bunfig.toml`: `preload = ["../preload.js"]` becomes `["./preload.js"]`, because the fixture root is the project root.
- `preload.js`: `import { mdxPlugin } from "./packages/smithers/src/mdx-plugin.js"` becomes `import { mdxPlugin } from "smthrs"`, the specifier an external project uses.

Authored, because the old repository holds them one level up:

- `package.json`: the dependency set an external 0.x project has, including the `effect@4.0.0-beta.105` pin the scanner reports as `effect-pin-conflict`, and the two old CLI scripts.
- `tsconfig.json`: the `jsx: react-jsx` and `jsxImportSource: smthrs` settings that make the JSX resolve without a pragma.
