/**
 * One row of the `prompts` collection — the live `listPrompts` RPC response
 * shape.
 *
 * The gateway builds each row by walking the project's `.smithers/prompts/`
 * directory for `.md`/`.mdx` files (the SAME prompt files smithers-studio reads).
 *
 * `entryFile` (the workspace-relative source path WITH extension) is the
 * collection's primary key because it is 1:1 with a real file. `id` strips the
 * extension, so it is NOT unique on its own — `foo.md` and `foo.mdx` both yield
 * id `foo`; keying the collection by `id` would collide and drop one prompt.
 * The editor still selects/labels by `id`, but uniqueness rides on `entryFile`.
 *
 * Field provenance (verified against the `listPrompts` handler in
 * `packages/server/src/gateway.js`):
 *  - `id`          — prompt path under `.smithers/prompts/` without extension
 *                    (e.g. `refactor`, `release-content/changelog`). NOT unique
 *                    across differing extensions; use `entryFile` as the PK.
 *  - `entryFile`   — workspace-relative source path WITH extension, unique per
 *                    file (e.g. `prompts/refactor.mdx`); the collection key.
 *  - `source`      — raw file text (`fs.readFileSync`).
 *  - `createdAtMs` — `fs.stat().birthtimeMs` (omitted when unavailable).
 *  - `updatedAtMs` — `fs.stat().mtimeMs` (omitted when unavailable).
 */
export type GatewayPromptRow = {
  id: string;
  entryFile: string;
  source: string;
  createdAtMs?: number;
  updatedAtMs?: number;
};
