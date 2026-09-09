import { readFile } from "node:fs/promises"
import { URL } from "node:url"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"

describe("operator documentation", () => {
  it("connects the rollout's split credentials to the workspace cache", async () => {
    const guide = await readFile(new URL("../../CACHE-TRUST.md", import.meta.url), "utf8")
    const example = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
      .map((match) => match[1]!)
      .find((source) => source.includes("RemoteCache.make"))
    expect(example).toBeDefined()

    // Evaluate the documented wiring with inert constructors. A standalone
    // RemoteCache export must not count as configuring Workspace.cache.remote.
    const constructors = {
      Secret: (env: string) => ({ env }),
      RemoteCache: { make: (options: unknown) => options },
      Cache: (options: unknown) => options,
      Workspace: (_name: string, options: unknown) => options
    }
    const source = example!.replace(/^import .*$/gm, "").replace(/^export /gm, "")
    const workspace: unknown = runInNewContext(
      `${source}\n; typeof Workspace === "undefined" ? undefined : Workspace`,
      { S: constructors, Smithers: constructors },
      { timeout: 1_000 }
    )
    expect(workspace).toMatchObject({
      cache: {
        directory: ".flows",
        remote: {
          endpoint: "https://build.smithers.sh",
          read: { env: "SMITHERS_CACHE_READ_TOKEN" },
          write: { env: "SMITHERS_CACHE_WRITE_TOKEN" }
        }
      }
    })
    expect(guide).toContain(".smithers/WORKSPACE.ts")
    expect(guide).toContain("docs/guides/remote-cache/")
  })

  it("documents process-long target-cache degradation separately from CAS recovery", async () => {
    const guide = (await readFile(new URL("../../README.md", import.meta.url), "utf8")).replace(/\s+/g, " ")
    expect(guide).not.toContain("clients treat as retryable")
    expect(guide).toMatch(/target-cache CLI[^.]*503[^.]*degraded/)
    expect(guide).toMatch(/local[^.]*rest of the process/)
    expect(guide).toContain("fresh invocation")
    expect(guide).toMatch(/CAS client[^.]*missing[^.]*republish/)
  })
})
