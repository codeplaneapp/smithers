import madge from "madge"
const result = await madge("src", { fileExtensions: ["ts"], tsConfig: "./tsconfig.json", detectiveOptions: { ts: { skipTypeImports: true } } })
if (result.circular().length > 0) { console.error("Circular dependencies found"); console.error(result.circular()); process.exitCode = 1 }
