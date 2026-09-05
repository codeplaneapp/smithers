import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { rewriteScripts } from "../../src/flow/Archive.ts"

const rewrite = (script: string) => rewriteScripts({ task: script })[0]!

describe("migration command semantics", () => {
  it.skipIf(process.platform === "win32").each([
    "ordinary text",
    "quotes ' and \"double\"",
    "spaces; ampersands && pipes | stay data",
    "Unicode 😀 日本語",
    "dollars $HOME ${VAR} $(echo inert)",
    "backticks `echo inert`",
    "backslashes \\ one\\two",
    "line\nbreak\ttab",
    "smithers up other.tsx --input '{}'"
  ])("preserves the complete JSON argv through a real POSIX shell: %s", (topic) => {
    const json = JSON.stringify({ topic, value: [null, true, 3] })
    const quoted = `'${json.replaceAll("'", "'\\''")}'`
    const result = rewrite(`smithers up hello.tsx --input ${quoted}`)
    expect(result.unsupported).toBeUndefined()
    const captured = spawnSync("/bin/sh", ["-c", "smthrs() { printf '%s\\0' \"$@\"; }\n" + result.after], {
      encoding: "utf8",
      timeout: 2_000
    })
    expect(captured.status, captured.stderr).toBe(0)
    expect(captured.stdout.split("\0")).toEqual(["flow", "start", "hello", "--data", json, ""])
  })

  it.each([
    ["smithers up hello.tsx", "smthrs flow start hello"],
    ["smthrs up hello.jsx", "smthrs flow start hello"],
    ["smithers workflow run nested/hello.tsx --input '{}'", "smthrs flow start nested/hello --data '{}'"],
    ["bunx smthrs up .smithers/workflows/ci.tsx -d", "smthrs flow start ci --detached"],
    ["npx -y smithers-orchestrator up ci.ts --input='{}'", "smthrs flow start ci --data='{}'"],
    ["npx -y smithers-orchestrator@0.35.0 up ci.ts --input='{}'", "smthrs flow start ci --data='{}'"],
    ["bunx smthrs@0.35.0 up ci.ts -d", "smthrs flow start ci --detached"],
    ["pnpm dlx smthrs@latest up ci.ts", "smthrs flow start ci"],
    ["pnpm dlx smthrs up ci.ts --detached", "smthrs flow start ci --detached"],
    ["pnpm exec smithers up ci.ts --data '{}'", "smthrs flow start ci --data '{}'"],
    [".smithers/node_modules/.bin/smithers up ci.tsx --json --quiet", "smthrs flow start ci --json --quiet"],
    ["smithers up ci.tsx -d '{\"topic\":\"x\"}'", "smthrs flow start ci --data '{\"topic\":\"x\"}'"],
    ["smithers up ci.tsx -d --input '{}'", "smthrs flow start ci --detached --data '{}'"],
    ["smithers up --input '{}' ci.tsx", "smthrs flow start ci --data '{}'"],
    ["smithers up './nested/a b.tsx' --input '{}'", "smthrs flow start 'nested/a b' --data '{}'"],
    ["MODE=test smithers up ci.tsx --input \"$INPUT\"", "MODE=test smthrs flow start ci --data \"$INPUT\""],
    [
      "echo before && smithers up a.tsx; smithers up b.jsx -d",
      "echo before && smthrs flow start a; smthrs flow start b --detached"
    ],
    ["smithers up a.tsx\nsmithers up b.tsx", "smthrs flow start a\nsmthrs flow start b"],
    ["smithers up a.tsx # leave --input here", "smthrs flow start a # leave --input here"],
    ["exec smithers up a.tsx", "exec smthrs flow start a"],
    ["smithers up a.tsx '--input={}'", "smthrs flow start a --data='{}'"],
    ["env MODE=test smithers up a.tsx --backend sqlite", "env MODE=test smthrs flow start a"],
    ["smithers up 'a; echo bad.tsx'", "smthrs flow start 'a; echo bad'"],
    ["smithers up a\\ b.tsx", "smthrs flow start 'a b'"],
    ["smithers up a.tsx | tee log", "smthrs flow start a | tee log"],
    ["smithers up a.tsx --input '{\"x\":\"$()\"}'", "smthrs flow start a --data '{\"x\":\"$()\"}'"],
    [
      "smithers up a.tsx --input '{\"command\":\"smithers up b.tsx --input {}\"}'",
      "smthrs flow start a --data '{\"command\":\"smithers up b.tsx --input {}\"}'"
    ]
  ])("rewrites %s without changing its input or execution mode", (before, after) => {
    expect(rewrite(before)).toEqual({ name: "task", before, after })
    expect(rewrite(after)).toEqual({ name: "task", before: after, after })
  })

  it.each([
    "echo 'smithers up hello.tsx'",
    "node -e 'console.log(\"smithers up hello.tsx\")'",
    "npm test",
    "'MODE'=test smithers up hello.tsx",
    "smthrs@0.35.0 up hello.tsx",
    "smthrs flow start hello --data '{}'"
  ])("leaves non-command text and canonical commands unchanged: %s", (before) => {
    expect(rewrite(before)).toEqual({ name: "task", before, after: before })
  })

  it.each([
    "smithers workflow run",
    "npx --package smithers smithers up a.tsx",
    "bunx smthrs@$VERSION up a.tsx",
    "pnpm dlx smthrs@0.35.0 up a.tsx > output.log",
    "smithers up $FLOW --input '{}'",
    "smithers up '*.tsx' --input '{}' --max-concurrency 32",
    "smithers up a.tsx --backend postgres",
    "smithers up a.tsx -d input.json",
    "smithers up a.tsx --input",
    "smithers up a.tsx --input '{}' --data '{}'",
    "smithers up a.tsx --input '[]'",
    "smithers up a.tsx --input '{'",
    "smithers up a.tsx --mystery=1",
    "smithers up a.tsx extra.tsx",
    "smithers up a.tsx > output.log",
    "(smithers up a.tsx)",
    "smithers up a.tsx --input 'unterminated",
    "smithers up a.tsx --remote https://example.invalid -d",
    "smithers up a.tsx --detached --detached",
    "smithers up a.tsx --detached=true",
    "smithers up a.tsx -d=foo",
    "smithers up a.tsx --input ''",
    "smithers up a.tsx --input null",
    "smithers up a.tsx --input --json",
    "smithers up a.tsx --backend $BACKEND",
    "smithers up a.tsx -d $INPUT",
    "smithers up a.tsx --input \"$(read-input)\"",
    "smithers up a.tsx \"--input=$INPUT\"",
    "smithers up ../a.tsx",
    "smithers up /tmp/a.tsx",
    "smithers up 'a\\b.tsx'",
    "smithers up ''",
    "smithers up 'a\u000bb.tsx'",
    "smithers up a.tsx \\",
    "if true; then smithers up a.tsx; fi",
    "smithers up a.tsx && smithers up b.tsx --max-concurrency 4"
  ])("reports an unsafe/unsupported rewrite and preserves the complete original: %s", (before) => {
    const result = rewrite(before)
    expect(result.after).toBe(before)
    expect(result.unsupported).toEqual(expect.any(String))
    expect(result.unsupported!.length).toBeGreaterThan(0)
  })
})
