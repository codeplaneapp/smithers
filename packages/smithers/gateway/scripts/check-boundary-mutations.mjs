/** Kill the two equality-boundary mutations demonstrated by the testing audit. */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const artifacts = mkdtempSync(join(tmpdir(), "smithers-gateway-mutations-"))
for (const [name, original, mutated] of [
  ["event-equality", "encodedBytes > maxProjectionBytes", "encodedBytes >= maxProjectionBytes"],
  ["row-equality", "bytes <= maxProjectionBytes", "bytes < maxProjectionBytes"]
]) {
  const config = join(artifacts, `${name}.config.mjs`)
  const report = join(artifacts, `${name}.json`)
  writeFileSync(config, `import base from ${JSON.stringify(pathToFileURL(join(root, "vitest.config.ts")).href)};
export default {
  ...base,
  plugins: [{ name: ${JSON.stringify(name)}, enforce: 'pre', transform(code, id) {
    if (!id.endsWith('/gateway/src/Projections.ts')) return null;
    if (!code.includes(${JSON.stringify(original)})) throw new Error('Mutation site missing');
    return code.replace(${JSON.stringify(original)}, ${JSON.stringify(mutated)});
  }}],
  test: { ...base.test, coverage: { enabled: false } }
};
`)
  const result = spawnSync("pnpm", ["exec", "vitest", "run", "test/ProjectionsUnit.test.ts", "--config", config, "--reporter=json", `--outputFile=${report}`], { cwd: root, encoding: "utf8" })
  writeFileSync(join(artifacts, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`)
  if (result.error !== undefined) throw result.error
  const outcome = JSON.parse(readFileSync(report, "utf8"))
  const failures = outcome.testResults.flatMap((file) => file.assertionResults).filter((test) => test.status === "failed")
  if (result.status !== 1 || failures.length !== 2 || failures.some((test) => !test.title.includes("encodings at N+0"))) {
    throw new Error(`${name} was not killed by exactly the two inclusive-boundary assertions; see ${artifacts}`)
  }
  console.log(`${name}: killed by both exact-limit assertions`)
}
console.log(`Mutation evidence: ${artifacts}`)
