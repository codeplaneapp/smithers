# Fixture: `smithers-0x-hello`

The smallest complete Smithers 0.x project: an init-pack `.smithers/` pack with
one workflow, its generated agent pool, its MDX prompt and its custom UI, plus a
standalone root-level JSX workflow with its own prompts and helper module.

It exercises both shapes the migration tool's detector recognizes as 0.x: a
`.smithers/workflows/*.tsx` pack, and a root `*.jsx` workflow that calls
`createSmithers`.

Origin: `/Users/williamcory/smithers` at commit `cfb570f193` (Smithers 0.35.0),
removed from the runtime tree during the 1.0 rewrite and assembled here as a
stable product fixture.

| Fixture path | Origin path |
| --- | --- |
| `.smithers/workflows/hello.tsx` | `examples/init-pack/hello.tsx` |
| `.smithers/agents/antigravity.ts` | `examples/agents/antigravity.ts` |
| `.smithers/agents/claude-code.ts` | `examples/agents/claude-code.ts` |
| `.smithers/agents/codex.ts` | `examples/agents/codex.ts` |
| `.smithers/agents/index.ts` | `examples/agents/index.ts` |
| `.smithers/agents/opencode.ts` | `examples/agents/opencode.ts` |
| `.smithers/prompts/hello.mdx` | `examples/prompts/hello.mdx` |
| `.smithers/ui/hello.tsx` | `examples/ui/hello.tsx` |
| `simple-workflow.jsx` | `examples/simple-workflow.jsx` |
| `_example-kit.js` | `examples/_example-kit.js` |
| `prompts/simple-workflow/research.mdx` | `examples/prompts/simple-workflow/research.mdx` |
| `prompts/simple-workflow/write.mdx` | `examples/prompts/simple-workflow/write.mdx` |

Every source file is byte-identical to its origin. The layout is the only thing
that changed: `hello.tsx` imports `../agents`, `../prompts/hello.mdx`, and
declares `<UI entry="../ui/hello.tsx" />`, so it sits at
`.smithers/workflows/hello.tsx` with those three directories as siblings, which
is where a real 0.x pack put them.

Authored, because the old repository held them one level up:

- `package.json`: the dependency set an external 0.x project has, including the
  `effect@4.0.0-beta.105` pin the detector reports as `effect-pin-conflict`, and
  two 0.x CLI scripts.
- `tsconfig.json`: the `jsx: react-jsx` and `jsxImportSource: smthrs` settings
  that make the JSX resolve without a per-file pragma.

The fixture is deliberately outside the pnpm workspace globs
(`packages/*`, `packages/smithers/build/infra`, `examples`, `apps/*`), so its
`package.json` is never installed and its 0.x dependencies are never resolved.
It is data, not a project that builds.
