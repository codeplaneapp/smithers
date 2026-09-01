// Renders the repository's root tsconfig.json from its declaration.
//
// The include and exclude lists decide what the root TypeScript program reads,
// which makes them part of the build definition rather than a hand-maintained
// file beside it. Root BUILD.ts holds that definition in its `tsconfig`
// declaration; this script renders it with `Tsconfig.render`, the same function
// the BUILD-mode Tsconfig rule calls, so the checked-in file keeps exactly one
// description and the rendered bytes match by construction.
//
// The script exists because package mode has no Tsconfig executor (see
// PackageExec.ts, "has no package-mode execution"). //:tsconfig in the root
// PACKAGE.ts wraps this script in an S.Generate: a bare label checks the
// checked-in file for drift, --write rewrites it.
//
// Deleting root BUILD.ts moves the `tsconfig` declaration into this file. Do
// not drop the gate instead.
import { writeFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { tsconfig } from "../BUILD.ts"
import * as Target from "../packages/targets/src/Target.ts"
import * as Tsconfig from "../packages/targets/src/Tsconfig.ts"

const attrs = Target.metadata(tsconfig).attrs

// `cwd` and `path` resolve the way the Tsconfig rule's implementation resolves
// them: a `cwd` of "." writes the bare path.
const destination = attrs.cwd === "." ? attrs.path : NodePath.join(attrs.cwd, attrs.path)

await writeFile(NodePath.join(process.cwd(), destination), Tsconfig.render(attrs), "utf8")
