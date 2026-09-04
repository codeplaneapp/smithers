/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"

const schema = S.file("schema.graphql")

const syncSchema = S.Shell.Diff({
  bun: "const res = await fetch(`https://raw.githubusercontent.com/artsy/metaphysics/main/_schemaV2.graphql`)\nawait Bun.write(`data/schema.graphql`, await res.text())\nawait $`${prettier} --write --parser graphql data/schema.graphql`",
  using: { prettier: S.NodeModule.Bin("prettier") },
  changes: ["schema.graphql"],
  sandbox: { network: true },
})

const syncSchemaLocal = S.Shell.Diff({
  bun: "if (!(await Bun.file(`../metaphysics/package.json`).exists())) throw new Error(`metaphysics must be checked out beside force`)\nawait $`${yarn} install`.cwd(`../metaphysics`)\nawait $`${yarn} dump-schema ${process.cwd()}/data/`.cwd(`../metaphysics`)",
  using: { yarn: S.PackageManager.bin },
  changes: ["schema.graphql"],
})

export const Package = S.Package({
  targets: { schema, syncSchema, syncSchemaLocal },
})
