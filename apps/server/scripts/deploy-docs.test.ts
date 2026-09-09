import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const guide = readFileSync(new URL("../DEPLOY.md", import.meta.url), "utf8")
const reference = readFileSync(new URL("../../site/src/content/docs/docs/reference/http-api.mdx", import.meta.url), "utf8")
const deploy = readFileSync(new URL("./deploy.ts", import.meta.url), "utf8")
const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")

test("deployment guide has one gateway migration and one upstream section", () => {
  expect(guide.match(/^### 1\.0 gateway migration$/gm)).toHaveLength(1)
  expect(guide.match(/^### Other upstream services$/gm)).toHaveLength(1)
})

test("frozen identity warning names every configured Durable Object binding", () => {
  const warning = guide.split("## Frozen identity")[1]!.split("Never edit")[0]!
  const bindings = [...config.matchAll(/"name":\s*"([A-Z_]+)",\s*"class_name":/g)]
  expect(bindings.length).toBeGreaterThan(0)
  for (const [, binding] of bindings) expect(warning).toContain(`\`${binding}\``)
})

for (const [name, source] of [["deployment guide", guide], ["HTTP reference", reference]] as const) {
  test(`${name} documents retired Worker mounts and the authenticated replacement`, () => {
    expect(source).not.toMatch(/When (?:the web Worker's )?`GATEWAY_UPSTREAM_URL` (?:is configured|is set)/)
    expect(source).not.toMatch(/relay (?:answers|fails closed with) `?501/)
    expect(source).not.toMatch(/Only ordinary `GET`|Ordinary `GET`/)
    for (const route of ["/rpc", "/projections", "/sync", "/health", "/api/workflow/provision", "/api/workflow/rpc"]) {
      expect(source).toContain(`\`${route}\``)
    }
    expect(source).toContain("gateway_proxy_removed")
    expect(source).toContain("HTTP 410")
    expect(source).toContain("validated, allowlisted session")
  })
}

test("receipt troubleshooting explains the publish-without-receipt failure and recovery", () => {
  expect(guide).not.toContain("does not guard either one")
  expect(guide).not.toContain("Either turns a real deploy into a receipt")
  expect(guide).toContain("exits with status 1 after publishing")
  expect(guide).toContain("no fresh receipt")
  expect(guide).toContain("latest.json` still describes the previous deployment")
  expect(guide).toContain("re-run the scripted deploy")
  const pin = /"(wrangler@[\d.]+)"/.exec(deploy)![1]!
  expect(guide).toContain(pin)
  expect(guide).not.toMatch(/wrangler@4\.123\.0|Wrangler\s+4\.123\.0/)
})
