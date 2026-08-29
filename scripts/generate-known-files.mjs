import { writeKnownFileDeclaration } from "../packages/targets/src/KnownFile.ts"
import { Effect } from "effect"

await Effect.runPromise(writeKnownFileDeclaration(process.cwd()))
